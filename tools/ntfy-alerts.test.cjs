'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPushConfig, buildPush, sendPush, decideAlert } = require('../ntfy-alerts.cjs');
const env = { NTFY_TOPIC_URL: 'https://example.invalid/private-test', NTFY_ACCESS_TOKEN: 'test_fixture_token_123456', ALERT_START_HOUR: '0', ALERT_END_HOUR: '0' };

test('disabled by default and fail closed on partial or invalid credentials', () => {
  assert.equal(loadPushConfig({}), null);
  assert.throws(() => loadPushConfig({ NTFY_TOPIC_URL: env.NTFY_TOPIC_URL }), { code: 'NTFY_CONFIG' });
  for (const bad of ['http://example.invalid/private-test','https://user@example.invalid/private-test','https://example.invalid/private-test?auth=something','https://example.invalid/private-test#x','https://example.invalid/a/b']) {
    assert.throws(() => loadPushConfig({ ...env, NTFY_TOPIC_URL: bad }), { code: 'NTFY_CONFIG' });
  }
});
test('same independent incident cadence and recovery semantics as email', () => {
  const config = loadPushConfig(env), now = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(decideAlert(null, 'Fail', config, now), 'failure');
  assert.equal(decideAlert(now - 60_000, 'Fail', config, now), null);
  assert.equal(decideAlert(now - 3_600_000, 'Fail', config, now), 'reminder');
  assert.equal(decideAlert(now - 60_000, 'Pass', config, now), 'recovery');
  assert.equal(decideAlert(null, 'Pass', config, now), null);
});
test('only minimal public data is sent; token goes in the authorization header and redirects are rejected', async () => {
  const config = loadPushConfig(env), run = { suite: 'conversion', checks: [{ detail: 'PRIVATE_FIXTURE' }], artifacts: ['private.png'] };
  let call;
  const result = await sendPush(config, 'failure', run, async (url, init) => { call = { url, init }; return { ok: true }; }, 0);
  assert(result.accepted); assert.equal(call.url, env.NTFY_TOPIC_URL); assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Authorization, `Bearer ${env.NTFY_ACCESS_TOKEN}`);
  assert(!call.init.body.includes('PRIVATE_FIXTURE')); assert(!call.init.body.includes('private.png'));
  assert.equal(call.init.headers['X-Click'], 'https://rammeshgar.github.io/exchange-universe-monitor/');
  assert.equal(buildPush('recovery', run, 0).priority, '3');
  await assert.rejects(sendPush(config, 'failure', run, async () => ({ ok: false })), { code: 'NTFY_DELIVERY' });
});
