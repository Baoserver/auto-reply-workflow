const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EventStore,
  PairingManager,
  MobileControlService,
  sanitizeEvent,
  summarizeEvents,
} = require('../dist/electron/mobileControlService.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-service-test-'));
}

test('PairingManager exchanges a valid pairing code for a reusable token', () => {
  const dir = tempDir();
  const pairing = new PairingManager(path.join(dir, 'auth.json'), () => new Date('2026-04-29T10:00:00Z'));

  const pair = pairing.startPairing();
  const completed = pairing.completePairing(pair.code, 'iPhone');

  assert.equal(typeof completed.token, 'string');
  assert.equal(completed.token.length > 20, true);
  assert.equal(pairing.isTokenValid(completed.token), true);
  assert.equal(pairing.completePairing(pair.code, 'another'), null);
});

test('EventStore redacts sensitive values and removes events older than seven days', () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events.json'), 7);
  const now = new Date('2026-04-29T12:00:00Z');

  store.addEvent({
    type: 'vision',
    data: {
      screenshot_path: '/Users/bao/private/capture.png',
      minimax_api_key: 'sk-secret',
      nested: { webhook_url: 'https://example.test/hook' },
    },
  }, now);
  store.addEvent({ type: 'reply', data: { content: 'ok' } }, new Date('2026-04-20T12:00:00Z'));

  const events = store.listEvents({ now });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'vision');
  assert.equal(events[0].data.screenshot_path, '[local-path]');
  assert.equal(events[0].data.minimax_api_key, '[redacted]');
  assert.equal(events[0].data.nested.webhook_url, '[redacted]');
});

test('summarizeEvents follows the desktop dashboard event counters', () => {
  const events = [
    { type: 'vision', ts: '2026-04-29T01:00:00.000Z', data: {} },
    { type: 'reply', ts: '2026-04-29T01:01:00.000Z', data: {} },
    { type: 'escalation', ts: '2026-04-29T01:02:00.000Z', data: {} },
    { type: 'log', ts: '2026-04-29T01:03:00.000Z', data: { message: 'OpenClaw route matched: agent=x' } },
    { type: 'log', ts: '2026-04-29T01:04:00.000Z', data: { message: 'OpenClaw assistant route matched: agent=y' } },
  ];

  const stats = summarizeEvents(events, new Date('2026-04-29T12:00:00Z'));

  assert.deepEqual(stats.day, {
    keywordHits: 1,
    visionRecognitions: 1,
    aiReplies: 1,
    escalations: 1,
  });
  assert.equal(stats.total.keywordHits, 1);
});

test('MobileControlService rejects unauthenticated control requests and accepts paired tokens', async () => {
  const dir = tempDir();
  let started = 0;
  const service = new MobileControlService({
    userDataPath: dir,
    host: '127.0.0.1',
    port: 0,
    getAgentRunning: () => false,
    startAgent: () => { started += 1; },
    stopAgent: () => {},
    runAgentOnce: async () => ({ ok: true }),
    checkProcess: async () => false,
    appVersion: '0.1.0',
  });

  await service.start();
  const baseUrl = `http://127.0.0.1:${service.port}`;
  try {
    const denied = await fetch(`${baseUrl}/api/agent/start`, { method: 'POST' });
    assert.equal(denied.status, 401);

    const pair = service.startPairing();
    const paired = await fetch(`${baseUrl}/api/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair.code, deviceName: 'iPhone' }),
    });
    assert.equal(paired.status, 200);
    const body = await paired.json();

    const allowed = await fetch(`${baseUrl}/api/agent/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(allowed.status, 200);
    assert.equal(started, 1);
  } finally {
    await service.stop();
  }
});
