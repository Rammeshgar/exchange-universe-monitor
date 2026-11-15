const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const target = 'https://sadeq.shinyapps.io/exchange_universe/';
const suite = process.argv[2] === 'regression' ? 'regression' : 'smoke';
const trigger = process.argv[3] === 'scheduled' ? 'scheduled' : 'manual';
const started = new Date();
const runPath = path.join(__dirname, 'runs', started.toISOString().replaceAll(':', '-'));
const checks = [];
const errors = [];
const artifacts = [];
let browser;
let page;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
}

async function check(name, task) {
  const start = performance.now();
  process.send?.({ step: name });
  try {
    checks.push({ name, status: 'Pass', detail: await task(), ms: Math.round(performance.now() - start) });
    return true;
  } catch (error) {
    checks.push({ name, status: 'Fail', detail: String(error.message).split('\n')[0], ms: Math.round(performance.now() - start) });
    errors.push({ check: name, message: String(error.message) });
    if (!artifacts.includes('failure.png')) await capture('failure.png');
    return false;
  }
}

async function capture(name) {
  try {
    await page.screenshot({ path: path.join(runPath, name), timeout: 6000 });
    artifacts.push(name);
  } catch (error) {
    errors.push({ check: 'Screenshot', message: String(error.message).split('\n')[0] });
  }
}

async function readConversion(amount) {
  await page.waitForFunction(value => {
    const source = document.querySelector('#conversion_result .conversion-equation')?.textContent.trim();
    const result = document.querySelector('#conversion_result .conversion-value');
    const currency = result?.querySelector('small')?.textContent.trim();
    const figure = result?.firstChild?.textContent.trim().replaceAll(',', '');
    return source === `${value.toFixed(2)} EUR equals` && currency === 'HUF' && /^[\d.]+$/.test(figure || '');
  }, amount, { timeout: 25000 });
  const result = await page.locator('#conversion_result .conversion-value').evaluate(node => Number(node.firstChild.textContent.trim().replaceAll(',', '')));
  assert(Number.isFinite(result) && result > 0, `Invalid HUF result for ${amount} EUR`);
  return result;
}

async function run() {
  await fs.mkdir(runPath, { recursive: true });
  try {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // Keep synthetic traffic out of the site's visitor analytics.
    await page.route(/https:\/\/[^/]*(?:clarity\.ms|google-analytics\.com|googletagmanager\.com)\//, route => route.abort());
    page.on('pageerror', error => errors.push({ check: 'Browser error', message: error.message }));
    const loaded = await check('Live app and Shiny session', async () => {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      assert(response?.ok(), `Expected successful HTTP response, got ${response?.status()}`);
      assert.equal(new URL(page.url()).origin, new URL(target).origin);
      // shinyapps.io can return a startup page while it wakes a sleeping worker.
      try {
        await page.locator('#tab_convert').waitFor({ state: 'visible', timeout: 60000 });
      } catch (error) {
        const title = await page.title().catch(() => 'Unavailable');
        const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        throw new Error(`HTTP ${response.status()}, but the dashboard did not become interactive within 60 s. ${title}${body.trim() ? ` — ${body.trim().replace(/\s+/g, ' ').slice(0, 220)}` : ''}`, { cause: error });
      }
      await page.waitForFunction(() => document.querySelector('#comparison_chart')?.classList.contains('shiny-bound-output'), null, { timeout: 25000 });
      return `HTTP ${response.status()}. Exchange Universe loaded and Shiny bound the chart output.`;
    });

    if (loaded) {
      await check('Currency history chart', async () => {
        const chart = await page.waitForFunction(() => {
          const host = document.querySelector('#comparison_chart');
          if (!host?.querySelector('canvas, svg')) return false;
          for (const node of [host, ...host.querySelectorAll('[_echarts_instance_]')]) {
            const series = window.echarts?.getInstanceByDom(node)?.getOption()?.series || [];
            const lines = series.filter(s => s.type === 'line' && s.data?.some(point => {
              const value = Array.isArray(point) ? point.at(-1) : point?.value ?? point;
              const y = Array.isArray(value) ? value.at(-1) : value;
              return typeof y === 'number' && Number.isFinite(y);
            }));
            if (lines.length) return lines.length;
          }
          return false;
        }, null, { timeout: 30000 });
        await capture('explore.png');
        return `${await chart.jsonValue()} chart series contain numeric data and a rendering surface is present.`;
      });

      await check('EUR → HUF conversion updates correctly', async () => {
        await page.locator('#tab_convert').click({ timeout: 10000 });
        const amount = page.locator('#amount');
        await amount.fill('100', { timeout: 10000 });
        await amount.press('Tab');
        const first = await readConversion(100);
        await amount.fill('200');
        await amount.press('Tab');
        const second = await readConversion(200);
        assert(Math.abs(second - 2 * first) <= 0.02, `Expected double the previous result, got ${first} → ${second} HUF`);
        await capture('conversion.png');
        return `100 EUR → ${first.toFixed(2)} HUF. 200 EUR → ${second.toFixed(2)} HUF. Doubling check passed within rounding tolerance.`;
      });

      if (suite === 'regression') {
        await check('Interactive currency atlas', async () => {
          await page.locator('#tab_explore').click({ timeout: 10000 });
          const mapReady = await page.waitForFunction(() => {
            const surface = document.querySelector('#world_map .leaflet-overlay-pane :is(canvas, svg)');
            if (!surface?.getBoundingClientRect().width || !window.L?.Polygon) return false;
            const map = window.HTMLWidgets?.find('#world_map')?.getMap?.();
            let count = 0;
            map?.eachLayer(layer => {
              if (layer instanceof window.L.Polygon && layer.options.interactive && layer.getLatLngs().length) count++;
            });
            return count > 10 ? count : false;
          }, null, { timeout: 20000 });
          const count = await mapReady.jsonValue();
          const toggle = page.locator('#map_fullscreen');
          await toggle.click({ timeout: 10000 });
          await page.waitForFunction(() => {
            const button = document.getElementById('map_fullscreen');
            const panel = document.getElementById('map_panel');
            return button?.getAttribute('aria-pressed') === 'true' && panel?.getBoundingClientRect().width >= innerWidth * .9;
          }, null, { timeout: 8000 });
          await capture('atlas.png');
          await toggle.click({ timeout: 8000 });
          await page.waitForFunction(() => document.getElementById('map_fullscreen')?.getAttribute('aria-pressed') === 'false', null, { timeout: 8000 });
          return `${count} interactive country shapes loaded. Expanded map opened and returned to its panel.`;
        });
        await check('Comparison data and CSV export', async () => {
          await page.locator('#tab_data').click({ timeout: 10000 });
          await page.waitForFunction(() => [...document.querySelectorAll('#data_table_slot tbody tr')].some(row => row.querySelectorAll('td').length > 1), null, { timeout: 20000 });
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            page.locator('#download_csv').click({ timeout: 12000 }),
          ]);
          assert.match(download.suggestedFilename(), /\.csv$/i);
          const content = await fs.readFile(await download.path(), 'utf8');
          const lines = content.trim().split(/\r?\n/);
          assert(lines.length > 1 && lines[0].includes(',') && /\b(?:USD|GBP|HUF)\b/.test(content), 'Expected a populated comparison CSV with currency codes');
          await fs.writeFile(path.join(runPath, 'comparison.csv'), content);
          artifacts.push('comparison.csv');
          await capture('data.png');
          return `Comparison table populated. CSV export contained ${lines.length - 1} data rows.`;
        });
      }
    } else {
      const skipped = ['Currency history chart', 'EUR → HUF conversion updates correctly'];
      if (suite === 'regression') skipped.push('Interactive currency atlas', 'Comparison data and CSV export');
      for (const name of skipped) {
        checks.push({ name, status: 'Skipped', detail: 'The app did not load.', ms: 0 });
      }
    }
  } catch (error) {
    checks.push({ name: 'Browser startup', status: 'Fail', detail: String(error.message).split('\n')[0], ms: 0 });
    errors.push({ check: 'Browser startup', message: String(error.message) });
  } finally {
    await browser?.close();
  }
  const status = checks.every(item => item.status === 'Pass') ? 'Pass' : 'Fail';
  const report = { target, suite, trigger, started: started.toISOString(), durationMs: Date.now() - started.getTime(), status, checks, artifacts, errors };
  await fs.writeFile(path.join(runPath, 'result.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(runPath, 'report.html'), renderReport(report));
  process.send?.({ result: started.toISOString().replaceAll(':', '-') });
  console.log(JSON.stringify({ ...report, reportPath: path.join(runPath, 'report.html') }, null, 2));
  process.exitCode = status === 'Pass' ? 0 : 1;
}

function renderReport(report) {
  const date = new Intl.DateTimeFormat('en-GB', {dateStyle:'long', timeStyle:'medium', timeZone:'Europe/Budapest'}).format(started);
  const rows = report.checks.map(({name,status,detail,ms}) => `<tr><th scope="row">${escapeHtml(name)}</th><td><strong class="${status.toLowerCase()}">${status}</strong></td><td>${(ms/1000).toFixed(2)} s</td><td>${escapeHtml(detail)}</td></tr>`).join('');
  const captures = report.artifacts.filter(file => file.endsWith('.png')).map(file => `<figure><a href="${file}"><img src="${file}" alt="${escapeHtml(file.replace('.png',''))} browser capture"></a><figcaption>${escapeHtml(file.replace('.png',''))}</figcaption></figure>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Exchange Universe monitoring</title>
<style>body{margin:0;background:#101929;color:#eff5ff;font:16px/1.55 system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:clamp(20px,5vw,64px)}h1{font-size:clamp(28px,5vw,48px);line-height:1.1;margin:.4em 0}h2{margin-top:1.8em}p,figcaption{color:#b8c8dc}a{color:#a7cdff}header{padding:0 0 24px;border-bottom:1px solid #394963}.pass{color:#92e5b5}.fail{color:#ffaea5}.skipped{color:#efcf86}.table{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid #394963;vertical-align:top}thead{background:#21314a}figure{margin:0}img{display:block;width:100%;border-radius:10px}figcaption{text-transform:capitalize;margin:.6rem 0 1.3rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:20px}</style>
<main><header><p>Exchange Universe · ${suite === 'regression' ? 'Regression' : 'Smoke'} · ${trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</p><h1>${report.status === 'Pass' ? 'All live checks passed' : 'Live checks need attention'}</h1><p>${escapeHtml(date)} Budapest time · ${(report.durationMs/1000).toFixed(1)} s</p><a href="${target}">Open the live app</a> · <a href="result.json">Raw results and error log</a></header>
<h2>Check results</h2><div class="table"><table><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Time</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>This run used one browser session and did not select Refresh rates. Conversion checks the app’s response to a changed amount. It does not independently verify the provider’s rate or its freshness.</p>
${captures ? `<h2>Browser captures</h2><div class="grid">${captures}</div>` : ''}</main></html>`;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
