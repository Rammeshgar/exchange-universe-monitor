const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parseEnv } = require('node:util');
const nodemailer = require('nodemailer');

const configPath = path.join(__dirname, 'email-alerts.env');
const suiteTitles = { smoke: 'Smoke Monitoring', regression: 'E2E Regression' };
const target = 'https://sadeq.shinyapps.io/exchange_universe/';
const cooldown = 60 * 60_000;

function integer(raw, fallback, name, min, max) {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error('Check ' + name + ' in email-alerts.env.'), { code: 'EMAIL_CONFIG' });
  }
  return value;
}

function configError(message) {
  return Object.assign(new Error(message), { code: 'EMAIL_CONFIG' });
}

async function loadConfig(file = configPath) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const env = parseEnv(content);
  for (const key of ['MAIL_SERVER_ADDRESS', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_SENDER_ADDRESS', 'MAIL_RECIPIENT_ADDRESS']) {
    if (!env[key]?.trim()) throw configError('Set ' + key + ' in email-alerts.env.');
  }
  const recipients = env.MAIL_RECIPIENT_ADDRESS.split(',').map(address => address.trim());
  const bareAddress = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
  if (![env.MAIL_SENDER_ADDRESS, ...recipients].every(address => bareAddress.test(address))) {
    throw configError('Use a verified sender and comma-separated email addresses in email-alerts.env.');
  }
  let clock;
  try {
    clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: env.ALERT_TIMEZONE || 'UTC' });
  } catch {
    throw configError('Enter a valid ALERT_TIMEZONE in email-alerts.env.');
  }
  return {
    host: env.MAIL_SERVER_ADDRESS,
    port: integer(env.MAIL_SERVER_PORT, 587, 'MAIL_SERVER_PORT', 1, 65535),
    username: env.MAIL_USERNAME,
    password: env.MAIL_PASSWORD,
    from: env.MAIL_SENDER_ADDRESS,
    recipients: [...new Set(recipients)],
    clock,
    startHour: integer(env.ALERT_START_HOUR, 4, 'ALERT_START_HOUR', 0, 23),
    endHour: integer(env.ALERT_END_HOUR, 17, 'ALERT_END_HOUR', 0, 23),
    maxBytes: integer(env.MAX_EMAIL_ATTACHMENT_MB, 20, 'MAX_EMAIL_ATTACHMENT_MB', 1, 20) * 1024 * 1024
  };
}

function decideAlert(lastFailureEmail, status, config, now = Date.now()) {
  if (status === 'Pass') return lastFailureEmail ? 'recovery' : null;
  if (status !== 'Fail') return null;
  const hour = Number(config.clock.format(now));
  const { startHour, endHour } = config;
  const inWindow = startHour === endHour || (startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour);
  if (!inWindow) return null;
  if (!lastFailureEmail) return 'failure';
  return now - lastFailureEmail >= cooldown ? 'reminder' : null;
}

async function buildMessage(config, type, run, evidenceDir, now = Date.now()) {
  const test = type === 'test';
  const failure = type === 'failure' || type === 'reminder';
  const title = test ? 'Test alarm' : suiteTitles[run.suite];
  const labels = { test: 'TEST', failure: 'FAILURE', reminder: 'STILL FAILING', recovery: 'RECOVERED' };
  const checkLines = test ? [] : run.checks.map(check => check.status + ' · ' + check.name + '\n' + check.detail);
  const attachments = [];
  let remaining = config.maxBytes;
  if (failure) {
    for (const filename of ['failure.png', 'result.json']) {
      try {
        const content = await readFile(path.join(evidenceDir, filename));
        if (content.length > remaining) continue;
        attachments.push({ filename, content });
        remaining -= content.length;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return {
    from: { name: 'Exchange Universe Monitor', address: config.from },
    to: config.recipients,
    subject: '[Exchange Universe] ' + labels[type] + ' · ' + title,
    text: [
      test ? 'This is a synthetic SMTP delivery test.' : title + (failure ? ' reported a failure.' : ' is passing again.'),
      'Time (UTC): ' + new Date(now).toISOString(),
      ...(test ? [] : ['Run started (UTC): ' + run.started, 'Trigger: ' + run.trigger]),
      'Exchange Universe: ' + target,
      ...checkLines
    ].join('\n\n'),
    attachments
  };
}

async function sendAlert(config, type, run, evidenceDir) {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.username, pass: config.password },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000,
    greetingTimeout: 12_000,
    socketTimeout: 25_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  const result = await transport.sendMail(await buildMessage(config, type, run, evidenceDir));
  return { accepted: result.accepted.length, rejected: result.rejected.length };
}

function errorLabel(error) {
  return /^[A-Z0-9_]{2,24}$/.test(error.code || '') ? error.code : 'SMTP_ERROR';
}

async function testEmail() {
  const config = await loadConfig();
  if (!config) throw configError('Copy email-alerts.env.example to email-alerts.env and fill in your mail settings.');
  const result = await sendAlert(config, 'test');
  console.log('SMTP accepted the test for ' + result.accepted + ' recipient(s).');
  if (result.rejected) {
    console.error('SMTP rejected ' + result.rejected + ' recipient(s). Check the recipient addresses.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  testEmail().catch(error => {
    console.error(error.code === 'EMAIL_CONFIG' ? error.message : 'Test email failed (' + errorLabel(error) + ').');
    process.exitCode = 1;
  });
}

module.exports = { loadConfig, decideAlert, sendAlert, buildMessage, errorLabel };
