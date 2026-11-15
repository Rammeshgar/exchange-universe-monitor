const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnvironmentConfig, decideAlert, sendAlert, errorLabel } = require('../alerts.cjs');

const root = path.join(__dirname, '..');
const suites = { smoke: { minutes: 15 }, regression: { minutes: 60 } };
const idPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
const retention = 200;
const safeRunUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
const publicScreenshots = new Set(['explore.jpg', 'conversion.jpg', 'atlas.jpg', 'data.jpg', 'failure.png']);

function hasImageSignature(file, image) {
  return file.endsWith('.jpg')
    ? image.subarray(0, 3).toString('hex') === 'ffd8ff'
    : image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function directories(folder) {
  try {
    return (await fs.readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && idPattern.test(entry.name)).map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveHostedRun(folder, id, run, sourceDir) {
  const destination = path.join(folder, id);
  await fs.mkdir(destination, { recursive: true });
  const artifacts = [];
  for (const file of new Set(run.artifacts || [])) {
    if (!publicScreenshots.has(file)) continue;
    const source = path.join(sourceDir, id, file);
    const meta = await fs.stat(source).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (meta?.isFile() && meta.size < 5 * 1024 * 1024) {
      const image = await fs.readFile(source);
      if (hasImageSignature(file, image)) {
        await fs.writeFile(path.join(destination, file), image);
        artifacts.push(file);
      }
    }
  }
  const runUrl = 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID;
  await writeJson(path.join(destination, 'result.json'), {
    id, suite: run.suite, trigger: run.trigger, started: run.started,
    durationMs: run.durationMs, status: run.status, artifacts,
    checks: run.checks.map(check => ({
      name: String(check.name).slice(0, 150), status: check.status,
      detail: String(check.detail).slice(0, 500), ms: check.ms
    })),
    ...(safeRunUrl.test(runUrl) ? { runUrl } : {})
  });
}

async function record(selection, trigger, target) {
  const chosen = selection === 'both' ? Object.keys(suites) : [selection];
  if (!chosen.every(suite => Object.hasOwn(suites, suite)) || !['manual', 'scheduled'].includes(trigger)) {
    throw new Error('Select smoke, regression or both, and a valid trigger.');
  }
  const runsDir = path.join(root, 'runs');
  const existing = new Set(await directories(runsDir));
  let allPassed = true;
  for (const suite of chosen) {
    const started = new Date();
    const monitor = spawnSync(process.execPath, [path.join(root, 'monitor.cjs'), suite, trigger], {
      cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, EXCHANGE_HOSTED_EVIDENCE: '1' }
    });
    const created = (await directories(runsDir)).filter(id => !existing.has(id)).sort().at(-1);
    const report = created && await readJson(path.join(runsDir, created, 'result.json'), null);
    if (created) existing.add(created);

    const run = report || {
      suite, trigger, started: started.toISOString(), durationMs: Date.now() - started.getTime(), status: 'Fail', artifacts: [],
      checks: [{ name: 'Monitor runner', status: 'Fail', ms: 0, detail: monitor.error?.code === 'ETIMEDOUT'
        ? 'The browser check exceeded four minutes.' : 'The browser process exited before saving its report.' }]
    };
    const id = run.started.replaceAll(':', '-');
    await saveHostedRun(target, id, run, runsDir);
    console.log(suite + ': ' + run.status);
    for (const check of run.checks) console.log('  ' + check.status + ' · ' + check.name);
    allPassed &&= run.status === 'Pass';
  }
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'healthy=' + allPassed + '\n');
}

const assets = {
  'echarts.js': 'node_modules/echarts/dist/echarts.min.js',
  'echarts-gl.js': 'node_modules/echarts-gl/dist/echarts-gl.min.js',
  'three.js': 'node_modules/three/build/three.min.js',
  'inter.woff2': 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'montserrat.woff2': 'node_modules/@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2',
  'ambient.mp3': 'dashboard/ambient.mp3',
  'logo-mark.svg': 'dashboard/logo-mark.svg'
};

async function publish(incoming, snapshot, site) {
  const archive = path.join(snapshot, 'runs');
  await fs.mkdir(archive, { recursive: true });
  const received = (await directories(incoming)).sort();
  if (!received.length) throw new Error('No browser results were received.');
  for (const id of received) {
    const from = path.join(incoming, id);
    const run = await readJson(path.join(from, 'result.json'));
    if (run.id !== id || !Object.hasOwn(suites, run.suite) || !['Pass', 'Fail'].includes(run.status)) {
      throw new Error('Invalid result in the workflow artifact.');
    }
    if (!Array.isArray(run.artifacts) || run.artifacts.some(file => !publicScreenshots.has(file))) {
      throw new Error('Unexpected files in the workflow result.');
    }
    const destination = path.join(archive, id);
    await fs.mkdir(destination, { recursive: true });
    for (const file of ['result.json', ...run.artifacts]) {
      await fs.copyFile(path.join(from, file), path.join(destination, file));
    }
  }

  const ids = (await directories(archive)).sort().reverse();
  for (const id of ids.slice(retention)) await fs.rm(path.join(archive, id), { recursive: true });
  const runs = await Promise.all(ids.slice(0, retention).map(id => readJson(path.join(archive, id, 'result.json'))));
  const incidents = Object.fromEntries(Object.keys(suites).map(suite => [
    suite, runs.find(run => run.suite === suite)?.status === 'Fail'
  ]));
  await fs.mkdir(path.join(site, 'assets'), { recursive: true });
  await fs.cp(archive, path.join(site, 'runs'), { recursive: true });
  for (const file of ['dashboard.js', 'dashboard.css', 'charts.js']) {
    await fs.copyFile(path.join(root, 'dashboard', file), path.join(site, file));
  }
  for (const [file, source] of Object.entries(assets)) {
    await fs.copyFile(path.join(root, source), path.join(site, 'assets', file));
  }
  const actionsUrl = 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions';
  const html = (await fs.readFile(path.join(root, 'dashboard', 'index.html'), 'utf8'))
    .replace('<body>', '<body data-hosted="true">')
    .replace('id="workflow-link"', 'id="workflow-link" href="' +
      (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions$/.test(actionsUrl) ? actionsUrl : 'https://github.com/Rammeshgar/exchange-universe-monitor/actions') + '"')
    .replace('class="run-controls-btn" id="controls-btn"', 'class="run-controls-btn" id="controls-btn" hidden');
  await fs.writeFile(path.join(site, 'index.html'), html);
  await writeJson(path.join(site, 'status.json'), { publishedAt: new Date().toISOString(), runs, suites, incidents });
  console.log('Prepared the public dashboard with ' + runs.length + ' saved checks.');
}

async function notify(snapshot, incoming) {
  const config = loadEnvironmentConfig(process.env);
  if (!config) {
    console.log('SMTP is unconfigured. Hosted checks and dashboard publication continue.');
    return;
  }
  const file = path.join(snapshot, 'smtp-incidents.json');
  const state = await readJson(file, {});
  for (const id of (await directories(incoming)).sort()) {
    const folder = path.join(incoming, id);
    const run = await readJson(path.join(folder, 'result.json'));
    const type = decideAlert(state[run.suite], run.status, config);
    if (!type) continue;
    try {
      const delivery = await sendAlert(config, type, run, folder);
      if (!delivery.accepted) throw Object.assign(new Error(), { code: 'EENVELOPE' });
      state[run.suite] = type === 'recovery' ? null : Date.now();
      await writeJson(file, state);
      console.log('SMTP ' + run.suite + ' ' + type + ': accepted ' + delivery.accepted + '; rejected ' + delivery.rejected + '.');
    } catch (error) {
      console.error('SMTP ' + run.suite + ' delivery failed (' + errorLabel(error) + ').');
      process.exitCode = 1;
    }
  }
}

const [mode, ...args] = process.argv.slice(2);
const job = { record, publish, notify }[mode];
if (typeof job !== 'function' || !Object.hasOwn({ record, publish, notify }, mode)) throw new Error('Unknown hosted monitor command.');
job(...args).catch(error => {
  console.error(error.code === 'EMAIL_CONFIG' ? 'Hosted SMTP configuration is incomplete.' : error.message);
  process.exitCode = 1;
});
