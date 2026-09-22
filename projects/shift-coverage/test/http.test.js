'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/app');
const { temporary } = require('./helpers/fixture');

async function listen(t, options) {
  const server = createServer(options);
  assert.equal(server.listening, false);
  t.after(() => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip(`Loopback listening is unavailable: ${error.code}`);
      return null;
    }
    throw error;
  }
  return (route, method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text, body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('HTTP test timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
const json = { 'Content-Type': 'application/json' };

test('real HTTP workflow persists coverage, exports a summary and cascades deletion', async (t) => {
  const file = temporary(t);
  const call = await listen(t, { dataFile: file });
  if (!call) return;
  assert.deepEqual((await call('/api/health')).body, { status: 'ok' });
  const post = async (route, body) => {
    const response = await call(`/api/${route}`, 'POST', JSON.stringify(body), json);
    assert.equal(response.status, 201);
    return response.body;
  };
  const event = await post('events', { name: 'Community day' });
  const volunteer = await post('volunteers', { name: 'Alex' });
  const shift = await post('shifts', { eventId: event.id, title: 'Welcome', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', capacity: 1 });
  assert.equal((await call('/api/coverage')).body[0].uncovered, 1);
  await post('assignments', { shiftId: shift.id, volunteerId: volunteer.id });
  assert.equal((await call('/api/assignments', 'POST', JSON.stringify({ shiftId: shift.id, volunteerId: volunteer.id }), json)).status, 409);
  const restarted = await listen(t, { dataFile: file });
  assert.equal((await restarted('/api/coverage')).body[0].covered, true);
  const exported = await call(`/api/summary?eventId=${event.id}`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment; filename="shift-coverage.txt"/);
  assert.match(exported.text, /1\/1 assigned \| 0 uncovered \| Volunteers: Alex/);
  const deleted = await call(`/api/events/${event.id}`, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.deepEqual((await call('/api/assignments')).body, []);
  assert.deepEqual((await call('/api/shifts')).body, []);
});

test('real HTTP rejects malformed, oversized and unsupported requests and serves safe local assets', async (t) => {
  const call = await listen(t, { dataFile: temporary(t) });
  if (!call) return;
  for (const [raw, headers, status] of [['{', json, 400], ['null', json, 400], ['{}', {}, 415], ['{}', { 'Content-Type': 'text/plain' }, 415], [JSON.stringify({ name: 'x'.repeat(17000) }), json, 413]]) {
    const response = await call('/api/events', 'POST', raw, headers);
    assert.equal(response.status, status);
    assert.equal(typeof response.body.error, 'string');
  }
  assert.deepEqual((await call('/api/events')).body, []);
  assert.equal((await call('/api/summary?eventId=missing')).status, 404);
  assert.equal((await call('/api/events/missing')).status, 404);
  const disallowed = await call('/api/events', 'DELETE');
  assert.equal(disallowed.status, 405);
  assert.equal(disallowed.headers.allow, 'GET, POST');
  for (const route of ['/src/store.js', '/data/coverage.json', '/unknown']) assert.equal((await call(route)).status, 404);
  for (const route of ['/', '/app.js', '/styles.css']) {
    const response = await call(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.equal((await call(route, 'HEAD')).text, '');
  }
});

test('real HTTP hides internal storage failures', async (t) => {
  const fail = () => { throw new Error('private implementation detail'); };
  const call = await listen(t, { store: { read: fail, mutate: fail } });
  if (!call) return;
  for (const response of [await call('/api/events'), await call('/api/events', 'POST', '{"name":"Test"}', json)]) {
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'Internal server error' });
  }
  assert.deepEqual((await call('/api/health')).body, { status: 'ok' });
});
