'use strict';

const { decideAlert } = require('./alerts.cjs');
const dashboard = 'https://rammeshgar.github.io/exchange-universe-monitor/';
const names = { smoke: 'Smoke Monitoring', regression: 'E2E Regression', conversion: 'Currency Conversion' };
const configError = () => Object.assign(new Error('Private ntfy configuration is incomplete or invalid.'), { code: 'NTFY_CONFIG' });

function hour(raw, fallback) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 23) throw configError();
  return value;
}

function loadPushConfig(env = process.env) {
  const endpoint = env.NTFY_TOPIC_URL?.trim(), token = env.NTFY_ACCESS_TOKEN?.trim();
  if (!endpoint && !token) return null;
  if (!endpoint || !token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw configError();
  let url, clock;
  try {
    url = new URL(endpoint);
    clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: env.ALERT_TIMEZONE || 'UTC' });
  } catch { throw configError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) throw configError();
  return { endpoint: url.href.replace(/\/$/, ''), token, clock, startHour: hour(env.ALERT_START_HOUR, 4), endHour: hour(env.ALERT_END_HOUR, 17) };
}

function buildPush(type, run, now = Date.now()) {
  if (!Object.hasOwn(names, run.suite) || !['failure', 'reminder', 'recovery'].includes(type)) throw configError();
  const recovery = type === 'recovery';
  const label = { failure: 'FAILED', reminder: 'STILL FAILING', recovery: 'RECOVERED' }[type];
  return {
    title: `Exchange Universe - ${label}`,
    message: `${names[run.suite]} ${recovery ? 'is passing again' : 'reported a failure'}.\nUTC: ${new Date(now).toISOString()}\nOpen the public dashboard for the run and evidence.`,
    priority: recovery ? '3' : '4', tags: recovery ? 'white_check_mark' : 'warning'
  };
}

async function sendPush(config, type, run, fetchImpl = global.fetch, now = Date.now()) {
  const payload = buildPush(type, run, now);
  const response = await fetchImpl(config.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'text/plain; charset=utf-8', 'X-Title': payload.title,
      'X-Priority': payload.priority, 'X-Tags': payload.tags, 'X-Click': dashboard },
    body: payload.message
  });
  if (!response.ok) throw Object.assign(new Error('ntfy delivery failed.'), { code: 'NTFY_DELIVERY' });
  return { accepted: true };
}

module.exports = { loadPushConfig, buildPush, sendPush, decideAlert };
