import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { canListen, canListenAll, formatReady, needsSeed, pickLanIp, pickPort, planUsers, reviewEnv } from '../scripts/lib/review-core.mjs';

test('pickLanIp: first non-internal IPv4, private preferred, none -> null', () => {
  const ifs = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.0.7', internal: false }],
    utun: [{ family: 4, address: '100.64.0.2', internal: false }],
    ap: [{ family: 'IPv4', address: '169.254.1.1', internal: false }],
  };
  assert.equal(pickLanIp(ifs), '192.168.0.7');
  assert.equal(pickLanIp({ a: [{ family: 'IPv4', address: '203.0.113.5', internal: false }] }), '203.0.113.5');
  assert.equal(pickLanIp({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
  assert.equal(pickLanIp({}), null);
});

test('pickPort: skips busy ports, returns null when all busy', async () => {
  const busy = new Set([4310, 4311]);
  assert.equal(await pickPort(4310, 4319, async p => !busy.has(p)), 4312);
  assert.equal(await pickPort(4310, 4311, async p => !busy.has(p)), null);
  assert.equal(await pickPort(4310, 4319, async () => true, [4310]), 4311);
});

test('canListen detects a busy port', async () => {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  assert.equal(await canListen(port, '127.0.0.1'), false);
  await new Promise(r => s.close(r));
  assert.equal(await canListen(port, '127.0.0.1'), true);
});

test('planUsers: create, reuse, and broken (user without saved password) are distinguished', () => {
  const r = planUsers(['demo-a', 'demo-b'], new Set(['demo-a']), new Set(['demo-a']));
  assert.deepEqual(r, [{ login: 'demo-a', action: 'reuse' }, { login: 'demo-b', action: 'create' }]);
  assert.equal(planUsers(['x'], new Set(['x']), new Set())[0].action, 'broken');
});

test('needsSeed is false once a trip exists', () => {
  assert.equal(needsSeed({ items: [] }), true);
  assert.equal(needsSeed(undefined), true);
  assert.equal(needsSeed({ items: [{ tripId: 't' }] }), false);
});

test('reviewEnv forces fixture, no Claude, no public origin', () => {
  const e = reviewEnv({ PROVIDER_MODE: 'live', ALLOW_CLAUDE_EXECUTION: 'true', PUBLIC_ORIGIN: 'https://x', GOOGLE_MAPS_SERVER_KEY: 'k' },
    { dbPath: '/d.sqlite', apiPort: 4312, webPort: 5174, sessionSecret: 's'.repeat(64) });
  assert.equal(e.PROVIDER_MODE, 'fixture');
  assert.equal(e.ALLOW_CLAUDE_EXECUTION, 'false');
  assert.equal(e.PUBLIC_ORIGIN, '');
  assert.equal(e.SHARED_BIND, '127.0.0.1');
  assert.equal(e.TKB_REVIEW_LAN, '1');
  assert.equal(e.TKB_API_PORT, '4312');
});

test('formatReady prints LAN url or the no-Wi-Fi notice', () => {
  const creds = [{ login: 'demo-a', password: 'p1' }, { login: 'demo-b', password: 'p2' }];
  const a = formatReady({ webPort: 5173, lanIp: '192.168.0.7', creds });
  assert.match(a, /http:\/\/192\.168\.0\.7:5173\//);
  assert.match(a, /demo-a \/ p1 {4}demo-b \/ p2/);
  assert.match(formatReady({ webPort: 5173, lanIp: null, creds }), /スマホからは開けません（Wi‑Fiに未接続）/);
});

test('canListenAll sees a listener bound to loopback only', async () => {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  assert.equal(await canListenAll(port), false);
  await new Promise(r => s.close(r));
  assert.equal(await canListenAll(port), true);
});
