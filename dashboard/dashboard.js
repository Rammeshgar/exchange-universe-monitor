const byId = id => document.getElementById(id);
const timezone = 'Europe/Budapest';
const timeFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone
});
const chartRangeFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone
});
const timezoneOffset = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
const dayMs = 86_400_000;
const lanes = [
    { key: 'smoke', short: 'Smoke', title: '💨 Smoke Monitoring', color: '#0ea5e9', environment: 'Production UI', hint: 'Checks app availability, Shiny startup, live chart data and EUR-to-HUF conversion.' },
    { key: 'regression', short: 'Regression', title: '🔍 E2E Regression', color: '#8b5cf6', environment: 'Production UI & CSV export', hint: 'Runs the Smoke checks and verifies the interactive atlas, comparison table and real CSV download.' },
    { key: 'conversion', short: 'Conversion', title: '💱 Currency Conversion', color: '#14b8a6', environment: 'Production converter', hint: 'Shows the conversion check from each recorded Smoke or Regression run. It checks that doubling the EUR input doubles the HUF result within rounding tolerance.' }
];
const captions = {
    'explore.png': 'Currency history chart', 'conversion.png': 'EUR to HUF conversion',
    'atlas.png': 'Expanded world atlas', 'data.png': 'Comparison table', 'failure.png': 'Browser at the time of failure'
};
const state = { mode: '2d', runs: [], status: null, connected: false };
const controls = byId('controls-dialog');
const details = byId('run-dialog');
const matrixButtons = [...document.querySelectorAll('.chart-btn')];
const cards = new Map();
let runSignature;
let statusSignature;
let activityError = '';

function element(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
}

function actionButton(label, handler, className) {
    const button = element('button', label, className);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
}

function suiteName(key) {
    return key === 'regression' ? 'Regression' : 'Smoke';
}

function runPath(id) {
    return '/runs/' + encodeURIComponent(id);
}

function outcomeFor(run, lane) {
    if (lane.key !== 'conversion') return run.suite === lane.key ? run.status : null;
    const check = run.checks.find(item => item.name.startsWith('EUR → HUF conversion'));
    return check?.status === 'Skipped' ? null : check?.status;
}

function initializeCards() {
    for (const lane of lanes) {
        const card = byId('card-template').content.firstElementChild.cloneNode(true);
        card.dataset.lane = lane.key;
        card.querySelector('h2').textContent = lane.title;
        card.querySelector('.info-icon').setAttribute('aria-label', lane.hint);
        card.querySelector('.tooltip').textContent = lane.hint;
        card.querySelector('.environment').textContent = lane.environment;
        cards.set(lane.key, card);
        byId('global-status').before(card);
    }
}

function updateCards() {
    for (const lane of lanes) {
        const card = cards.get(lane.key);
        const last = state.runs.find(run => outcomeFor(run, lane));
        const result = last && outcomeFor(last, lane);
        const badge = card.querySelector('.status-badge');
        const active = state.status?.active?.suite;
        const running = lane.key === active || (lane.key === 'conversion' && active);
        badge.className = 'status-badge ' + (result === 'Pass' ? 'status-passed' : result === 'Fail' ? 'status-failed' : 'status-inactive');
        badge.querySelector('.status-caption').textContent = running ? 'RUNNING' : ({ Pass: 'PASSING', Fail: 'FAILING' }[result] || 'WAITING');
        const waveform = result === 'Fail'
            ? 'M0 15h17l9-12 13 26 12-26 12 24 12-12h25'
            : 'M0 15H23l9-6 8 6h11l9-13 9 24 8-11h23';
        for (const line of badge.querySelectorAll('path')) {
            if (line.getAttribute('d') !== waveform) line.setAttribute('d', waveform);
        }
        card.querySelector('.checked').textContent = last ? timeFormat.format(Date.parse(last.started)) : '—';
        const evidence = card.querySelector('.card-evidence');
        const view = () => openRun(last.id);
        if (result === 'Fail' && last.artifacts?.includes('failure.png')) {
            const button = actionButton(undefined, view, 'screenshot-container');
            const image = element('img', undefined, 'screenshot');
            image.src = runPath(last.id) + '/failure.png';
            image.alt = 'View evidence for ' + lane.short + ' failure';
            button.append(image);
            evidence.replaceChildren(button);
        } else if (last) {
            const label = result === 'Fail' ? '⚠ Check needs attention. View run.' : '✅ Latest check passed. View run.';
            evidence.replaceChildren(actionButton(label, view, result === 'Fail' ? 'needs-attention' : 'no-failures'));
        } else {
            evidence.replaceChildren(element('p', 'Waiting for the first result.', 'meta'));
        }
    }
    const incident = Object.values(state.status?.incidents || {}).some(Boolean);
    const collecting = !lanes.every(lane => state.runs.some(run => outcomeFor(run, lane)));
    const system = byId('global-text');
    const label = !state.connected ? 'Disconnected' : incident ? 'Degraded' : collecting ? 'Collecting data' : 'All Operational';
    system.textContent = label;
    system.className = !state.connected || incident ? 'degraded' : collecting ? '' : 'operational';
    byId('global-led').className = 'status-led ' + (!state.connected || incident ? 'led-fail' : collecting ? '' : 'led-pass');
}

function midnight(value) {
    const utc = Date.parse(value + 'T00:00:00Z');
    const offsetText = timezoneOffset.formatToParts(utc).find(part => part.type === 'timeZoneName').value;
    const offsetHours = Number(offsetText.slice(3));
    return utc - offsetHours * 3_600_000;
}

function selectedRange() {
    const first = byId('start-date').value;
    const last = byId('end-date').value;
    const error = byId('date-error');
    const invalid = first && last && first > last;
    error.textContent = invalid ? 'Choose an end date on or after the start date.' : '';
    error.hidden = !invalid;
    byId('end-date').setAttribute('aria-invalid', Boolean(invalid));
    if (invalid) return null;
    const followingDay = last && new Date(Date.parse(last + 'T00:00:00Z') + dayMs).toISOString().slice(0, 10);
    const now = Date.now();
    const start = first ? midnight(first) : (followingDay ? midnight(followingDay) : now) - dayMs;
    const end = followingDay ? midnight(followingDay) : Math.max(now, start + dayMs);
    return { start, end, viewportStart: start, automatic: !first && !last };
}

function runsInRange(span) {
    if (!span) return [];
    return state.runs.filter(run => {
        const time = Date.parse(run.started);
        return time >= span.start && time < span.end;
    });
}

function showMessage(message, allowTable = false) {
    const box = byId('chart-message');
    box.replaceChildren(message);
    if (allowTable) box.append(actionButton('Open Data Table', () => setMode('table'), 'chart-btn active'));
    box.hidden = !message;
}

function showRange(start, end) {
    byId('chart-range').textContent = chartRangeFormat.formatRange(start, Math.max(start, end - 1)) +
        ' · Budapest time (24-hour)';
}

function renderHistory() {
    const range = selectedRange();
    const results = runsInRange(range);
    if (range?.automatic && results.length) {
        // Keep the full day on the scrubber and start with the portion that contains results.
        const firstRun = Date.parse(results.at(-1).started);
        range.viewportStart = Math.max(range.start, Math.min(firstRun - 5 * 60_000, range.end - 60 * 60_000));
    }
    const shownStart = state.mode === 'table' ? range?.start : range?.viewportStart;
    if (range) showRange(shownStart, range.end);
    else byId('chart-range').textContent = '';
    if (state.mode === 'table') {
        const rows = results.map(run => {
            const row = element('tr');
            for (const value of [timeFormat.format(Date.parse(run.started)), suiteName(run.suite), run.status, (run.durationMs / 1000).toFixed(1) + ' s']) {
                row.insertCell().textContent = value;
            }
            row.insertCell().append(actionButton('View run ↗', () => openRun(run.id), 'table-link'));
            return row;
        });
        if (!rows.length) {
            const row = element('tr');
            const cell = row.insertCell();
            cell.colSpan = 5;
            cell.textContent = range ? 'No runs in this date range.' : 'Correct the date range to view runs.';
            rows.push(row);
        }
        byId('run-table').replaceChildren(...rows);
        byId('export').disabled = !results.length;
        return;
    }

    if (!range || !results.length) {
        stabilityMatrix.clear();
        byId('chart-guide').hidden = true;
        showMessage(range ? 'No runs in this date range.' : 'Correct the date range to view runs.');
        return;
    }
    const series = lanes.map(lane => ({
        ...lane,
        points: results.slice().reverse().flatMap(run => {
            const outcome = outcomeFor(run, lane);
            return outcome ? [{ time: Date.parse(run.started), pass: Number(outcome === 'Pass'), id: run.id }] : [];
        })
    }));
    try {
        const available = stabilityMatrix.render(state.mode, series, range, openRun, showRange);
        byId('chart-guide').hidden = state.mode !== '3d' || !available;
        byId('chart-guide').classList.toggle('active', state.mode === '3d' && available);
        if (!available) stabilityMatrix.clear();
        showMessage(available ? '' : 'WebGL is unavailable in this browser.', !available);
    } catch (error) {
        console.error('Stability matrix:', error);
        stabilityMatrix.clear();
        byId('chart-guide').hidden = true;
        showMessage('The chart could not load.', true);
    }
}

function setMode(mode) {
    state.mode = mode;
    for (const button of matrixButtons) {
        const selected = button.dataset.mode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    }
    byId('chartContainer').hidden = mode === 'table';
    byId('tableContainer').hidden = mode !== 'table';
    renderHistory();
}

function openRun(id) {
    const run = state.runs.find(item => item.id === id);
    if (!run) return;
    byId('run-title').textContent = suiteName(run.suite) + ' · Test Details';
    const base = runPath(id);
    const summary = element('dl', undefined, 'detail-grid');
    for (const [term, value] of [
        ['Result', run.status], ['Checked · Budapest time', timeFormat.format(Date.parse(run.started))],
        ['Trigger', run.trigger], ['Duration', (run.durationMs / 1000).toFixed(1) + ' s']
    ]) {
        const item = element('div');
        item.append(element('dt', term), element('dd', value));
        summary.append(item);
    }
    const checks = element('ul', undefined, 'check-list');
    for (const check of run.checks) {
        const item = element('li');
        const pill = element('span', check.status, check.status === 'Pass' ? 'pill-pass' : check.status === 'Fail' ? 'pill-fail' : '');
        item.append(pill, element('strong', check.name), element('p', check.detail));
        checks.append(item);
    }
    const files = element('div', undefined, 'download-row');
    const json = element('a', 'Download result JSON');
    json.href = base + '/result.json';
    json.download = 'result.json';
    files.append(json);
    const images = element('div', undefined, 'modal-images');
    for (const filename of run.artifacts || []) {
        if (filename === 'comparison.csv') {
            const csv = element('a', 'Download comparison CSV');
            csv.href = base + '/comparison.csv';
            csv.download = filename;
            files.append(csv);
        }
        if (!Object.hasOwn(captions, filename)) continue;
        const anchor = element('a');
        const image = element('img');
        anchor.href = image.src = base + '/' + filename;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        image.alt = captions[filename];
        image.loading = 'lazy';
        anchor.append(image);
        images.append(anchor);
    }
    byId('run-detail').replaceChildren(summary, checks, files, images);
    if (!details.open) details.showModal();
    byId('run-title').focus();
}

function setText(id, value) {
    const node = byId(id);
    if (node.textContent !== value) node.textContent = value;
}

function updateControls() {
    const status = state.status;
    const active = status?.active;
    byId('run').disabled = !state.connected || Boolean(active);
    byId('schedule').disabled = !state.connected;
    setText('run', active ? 'Running…' : '▶ Run check');
    setText('schedule', status?.enabled ? 'Pause schedule' : 'Resume schedule');
    setText('activity', activityError || (!state.connected ? 'Local monitor disconnected. Reconnecting…' :
        active ? suiteName(active.suite) + ' · ' + active.step : status.lastError || 'Ready for a live check.'));
    setText('next-checks', status?.enabled
        ? 'Next scheduled checks · Smoke ' + timeFormat.format(status.next.smoke) + ' · Regression ' + timeFormat.format(status.next.regression) + ' · Budapest time'
        : 'Automatic checks are paused.');
}

async function syncStatus() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('Local monitor unavailable');
        const status = await response.json();
        const oldSignature = runSignature;
        runSignature = status.runs.map(run => run.id).join('|');
        state.status = status;
        state.runs = status.runs;
        state.connected = true;
        const changes = JSON.stringify([runSignature, status.active?.suite, status.incidents]);
        if (changes !== statusSignature) {
            statusSignature = changes;
            updateCards();
        }
        if (oldSignature !== runSignature) renderHistory();
    } catch {
        state.connected = false;
        statusSignature = undefined;
        updateCards();
    } finally {
        updateControls();
    }
}

async function sendAction(button, endpoint) {
    activityError = '';
    button.disabled = true;
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Monitor-Action': 'run' } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
    } catch (error) {
        activityError = error.message;
    }
    await syncStatus();
}

function exportHistory() {
    const results = runsInRange(selectedRange());
    if (!results.length) return;
    const type = byId('export-format').value;
    const records = results.map(run => ({
        started: run.started, suite: suiteName(run.suite), trigger: run.trigger, status: run.status, durationMs: run.durationMs
    }));
    const quote = item => '"' + String(item).replaceAll('"', '""') + '"';
    const lines = records.map(row => Object.values(row).map(quote).join(','));
    const contents = type === 'json' ? JSON.stringify(records, null, 2) :
        type === 'txt' ? records.map(row => Object.values(row).join(' · ')).join('\r\n') :
        [Object.keys(records[0]).join(','), ...lines].join('\r\n');
    const mime = { csv: 'text/csv', json: 'application/json', txt: 'text/plain' };
    const url = URL.createObjectURL(new Blob([contents], { type: mime[type] + ';charset=utf-8' }));
    const download = element('a');
    download.href = url;
    download.download = 'exchange-universe-runs.' + type;
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    byId('theme-btn').textContent = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
    stabilityMatrix.updateFloor();
    if (state.connected) renderHistory();
}

initializeCards();
applyTheme(localStorage.getItem('exchange-monitor-theme') === 'light' ? 'light' : 'dark');
stabilityMatrix.startFloor();
byId('theme-btn').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('exchange-monitor-theme', theme);
    applyTheme(theme);
});
byId('controls-btn').addEventListener('click', () => controls.showModal());
for (const dialog of [details, controls]) {
    const close = dialog.querySelector('.modal-close');
    close.addEventListener('click', event => { event.preventDefault(); dialog.close(); });
}
for (const button of matrixButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
for (const id of ['start-date', 'end-date']) byId(id).addEventListener('change', renderHistory);
byId('export').addEventListener('click', exportHistory);
byId('run').addEventListener('click', event => sendAction(event.currentTarget, '/api/run?suite=' + byId('suite').value));
byId('schedule').addEventListener('click', event => sendAction(event.currentTarget, '/api/schedule?enabled=' + (state.status?.enabled ? '0' : '1')));

const music = byId('ambient-music');
const musicButton = byId('music-btn');
function showMusicState() {
    const playing = !music.paused;
    musicButton.textContent = playing ? '🎵 Music On' : '🔇 Music Off';
    musicButton.setAttribute('aria-pressed', String(playing));
    musicButton.classList.toggle('playing', playing);
}
music.volume = .25;
music.addEventListener('play', showMusicState);
music.addEventListener('pause', showMusicState);
musicButton.addEventListener('click', async () => {
    if (!music.paused) {
        music.pause();
        return;
    }
    musicButton.disabled = true;
    try {
        await music.play();
    } catch {
        musicButton.textContent = 'Music unavailable · Retry';
    } finally {
        musicButton.disabled = false;
    }
});

async function poll() {
    await syncStatus();
    setTimeout(poll, 1500);
}
poll();
