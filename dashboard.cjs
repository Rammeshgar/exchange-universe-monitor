const { createServer } = require('node:http');
const { fork } = require('node:child_process');
const { readFile, readdir, mkdir, writeFile } = require('node:fs/promises');
const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');
const { loadConfig, decideAlert, sendAlert, errorLabel } = require('./alerts.cjs');

const port = 4914;
const host = `127.0.0.1:${port}`;
const runsDir = path.join(__dirname, 'runs');
const stateFile = path.join(__dirname, 'monitor-state.json');
const runId = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z$/;
const suites = { smoke: { name: 'Smoke', minutes: 15 }, regression: { name: 'Regression', minutes: 60 } };
const intervalFor = suite => suites[suite].minutes * 60000;
const emptyState = { enabled: true, incidents: {} };
const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : emptyState;
saved.emailIncidents ||= {};
const next = {};
let mailQueue = Promise.resolve();
const assets = new Map([
  ['/', ['dashboard/index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard/dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/charts.js', ['dashboard/charts.js', 'text/javascript; charset=utf-8']],
  ['/assets/echarts.js', ['node_modules/echarts/dist/echarts.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/echarts-gl.js', ['node_modules/echarts-gl/dist/echarts-gl.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/three.js', ['node_modules/three/build/three.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/inter.woff2', ['node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'font/woff2']],
  ['/assets/montserrat.woff2', ['node_modules/@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2', 'font/woff2']],
  ['/assets/ambient.mp3', ['dashboard/ambient.mp3', 'audio/mpeg']],
]);
let active = null;
let lastError = null;

function persist() {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(saved, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}

function resetSchedule() {
  for (const key of Object.keys(suites)) next[key] = Date.now() + intervalFor(key);
}
resetSchedule();

async function history() {
  const directories = await readdir(runsDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = directories.filter(entry => entry.isDirectory() && runId.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 300);
  const results = await Promise.all(candidates.map(async entry => {
    try {
      const run = JSON.parse(await readFile(path.join(runsDir, entry.name, 'result.json'), 'utf8'));
      return { suite: 'smoke', trigger: 'manual', ...run, id: entry.name };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }));
  return results.filter(Boolean).sort((a, b) => b.started.localeCompare(a.started));
}

function trackIncident(run, id) {
  const suite = run.suite;
  saved.incidents[suite] = run.status === 'Pass'
    ? null
    : { since: saved.incidents[suite]?.since || run.started };
  persist();

  mailQueue = mailQueue.then(async () => {
    const config = await loadConfig();
    if (!config) return;
    const type = decideAlert(saved.emailIncidents[suite], run.status, config);
    if (!type) return;
    const delivery = await sendAlert(config, type, run, path.join(runsDir, id));
    if (delivery.accepted === 0) throw Object.assign(new Error(), { code: 'EENVELOPE' });
    saved.emailIncidents[suite] = type === 'recovery' ? null : Date.now();
    persist();
    console.log(`SMTP ${suite} ${type}: accepted ${delivery.accepted}; rejected ${delivery.rejected}.`);
  }).catch(error => console.error(`SMTP ${suite}: ${errorLabel(error)}.`));
}

function startRun(suite, trigger) {
  const state = { suite, trigger, started: new Date().toISOString(), step: 'Starting Chromium' };
  const child = fork(path.join(__dirname, 'monitor.cjs'), [suite, trigger], { silent: true, windowsHide: true });
  active = state;
  lastError = null;
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  let resultId;
  child.on('message', message => {
    if (active === state && typeof message?.step === 'string') state.step = message.step;
    if (typeof message?.result === 'string' && runId.test(message.result)) resultId = message.result;
  });
  child.on('error', error => { lastError = error.message; });
  const timeout = setTimeout(() => {
    lastError = 'The browser run exceeded the 4-minute limit.';
    child.kill();
  }, 240000);
  child.on('close', async (code, signal) => {
    clearTimeout(timeout);
    try {
      if (!resultId) {
        lastError ||= stderr.trim().split('\n')[0] || `Browser process ended before saving results (${signal || code}).`;
        const id = state.started.replaceAll(':', '-');
        const run = {
          suite, trigger, started: state.started, durationMs: Date.now() - Date.parse(state.started), status: 'Fail', artifacts: [],
          checks: [{ name: 'Monitor runner', status: 'Fail', detail: lastError, ms: 0 }], errors: [{ message: lastError }],
        };
        await mkdir(path.join(runsDir, id), { recursive: true });
        await writeFile(path.join(runsDir, id, 'result.json'), JSON.stringify(run, null, 2));
        trackIncident(run, id);
      } else {
        const result = JSON.parse(await readFile(path.join(runsDir, resultId, 'result.json'), 'utf8'));
        trackIncident(result, resultId);
      }
    } catch (error) {
      lastError = `Result processing failed: ${error.message}`;
      console.error(lastError);
    } finally {
      active = null;
    }
  });
}

function tickSchedule() {
  if (!saved.enabled || active) return;
  const now = Date.now();
  const due = Object.keys(suites).filter(key => next[key] <= now).sort((a, b) => next[a] - next[b]);
  if (!due.length) return;
  const suite = due[0];
  // After sleep, run each overdue suite once rather than replaying missed checks.
  next[suite] = now + intervalFor(suite);
  startRun(suite, 'scheduled');
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // ECharts GL compiles the bundled compositor's size expressions with new Function.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (req.headers.host !== host) return json(res, 403, { error: 'Use the local dashboard address.' });
  try {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'POST') {
      // A cross-site form or request cannot start a local browser run.
      if (req.headers.origin !== `http://${host}` || req.headers['x-monitor-action'] !== 'run') {
        return json(res, 403, { error: 'Run checks from the local dashboard.' });
      }
      if (url.pathname === '/api/run') {
        if (active) return json(res, 409, { error: 'A check is already running.' });
        const suite = url.searchParams.get('suite') || 'smoke';
        if (!Object.hasOwn(suites, suite)) return json(res, 400, { error: 'Choose Smoke or Regression.' });
        startRun(suite, 'manual');
        return json(res, 202, { active });
      }
      if (url.pathname === '/api/schedule') {
        const enable = url.searchParams.get('enabled');
        if (!['0', '1'].includes(enable)) return json(res, 400, { error: 'Specify the schedule state.' });
        saved.enabled = enable === '1';
        if (saved.enabled) resetSchedule();
        persist();
        return json(res, 200, { enabled: saved.enabled });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not available.' });
    if (url.pathname === '/api/status') return json(res, 200, { runs: await history(), active, lastError, enabled: saved.enabled, next, suites, incidents: saved.incidents });
    const artifact = /^\/runs\/(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)\/(explore\.png|conversion\.png|atlas\.png|data\.png|failure\.png|result\.json|comparison\.csv)$/.exec(url.pathname);
    const mime = { '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
    const asset = assets.get(url.pathname);
    const file = asset ? [path.join(__dirname, asset[0]), asset[1]] : artifact && [path.join(runsDir, artifact[1], artifact[2]), mime[path.extname(artifact[2])]];
    if (!file) return json(res, 404, { error: 'Not found.' });
    const bytes = await readFile(file[0]);
    res.writeHead(200, { 'Content-Type': file[1] });
    res.end(bytes);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
    json(res, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Not found.' : 'The dashboard could not read the results.' });
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Local dashboard: http://${host}/`);
  setInterval(tickSchedule, 2000).unref();
});
