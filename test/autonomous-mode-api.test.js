const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { modeFixture } = require('./autonomous-mode-helpers');

async function serverFixture(t) {
  const f = await modeFixture(t);
  const app = createApp({ projectRepository: f.dependencies.projectRepository, autonomousService: f.dependencies.autonomousService,
    autonomousModeService: f.service, executionService: { async initialize() {} }, publisherService: f.dependencies.publisher });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body = {}, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...f, base, post };
}

test('session API defaults, duplicate Start 409, manual conflict, Pause/Resume/Stop', async t => {
  const f = await serverFixture(t);
  assert.equal((await (await fetch(f.base + '/api/autonomous-mode')).json()).session, null);
  const responses = await Promise.all([f.post('/api/autonomous-mode/start'), f.post('/api/autonomous-mode/start')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409]);
  const started = await responses.find(r => r.status === 202).json();
  assert.equal(started.session.maxProjects, 5); assert.equal(started.session.autoPublish, false);
  assert.equal((await f.post('/api/autonomous/start')).status, 409);
  assert.equal((await f.post('/api/autonomous-mode/pause')).status, 202); await f.service.tick();
  const resumed = await f.post('/api/autonomous-mode/resume'); assert.equal(resumed.status, 202);
  assert.equal((await resumed.json()).session.id, started.session.id);
  assert.equal((await f.post('/api/autonomous-mode/stop')).status, 202); await f.service.tick();
  assert.equal((await f.post('/api/autonomous/start', { requestId: 'manual' })).status, 202);
});

test('session API rejects unsafe fields, invalid bounds and invalid control bodies', async t => {
  const f = await serverFixture(t);
  for (const key of ['command', 'workspace', 'provider', 'remote', 'branch', 'path', 'PID', 'codexArguments']) {
    assert.equal((await f.post('/api/autonomous-mode/start', { [key]: 'unsafe' })).status, 400);
  }
  for (const body of [{ maxProjects: 11 }, { maxProjects: 0 }, { maxProjects: '3' }, { autoPublish: null }, { stopOnNeedsAttention: 0 }, [], null]) assert.equal((await f.post('/api/autonomous-mode/start', body)).status, 400);
  for (const action of ['pause', 'resume', 'stop']) {
    assert.equal((await f.post('/api/autonomous-mode/' + action, { path: 'x' })).status, 400);
    assert.equal((await f.post('/api/autonomous-mode/' + action)).status, 409);
  }
  assert.equal((await f.post('/api/autonomous-mode/start?provider=codex')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('session API enforces JSON, same-origin and safe presentation without execution output', async t => {
  const f = await serverFixture(t);
  assert.equal((await f.post('/api/autonomous-mode/start', {}, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.post('/api/autonomous-mode/start', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(f.base + '/api/autonomous-mode/start', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(f.base + '/api/autonomous-mode/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  await f.post('/api/autonomous-mode/start'); await f.service.tick();
  await f.settle('failed', { needsAttention: true, error: 'PRIVATE_STDERR', stdout: 'PRIVATE_STDOUT' }); await f.service.tick();
  const dto = await (await fetch(f.base + '/api/autonomous-mode')).json();
  assert.equal(dto.session.status, 'needs_attention'); assert.equal(JSON.stringify(dto).includes('PRIVATE_'), false);
  assert.equal((await f.post('/api/autonomous/run-1/resume')).status, 409);
});

test('Autonomous Mode cannot bypass publisher localhost Host boundary', async t => {
  const f = await serverFixture(t);
  for (const route of ['/api/autonomous-mode/start', '/API/AUTONOMOUS-MODE/start']) {
    const status = await new Promise((resolve, reject) => {
      const request = require('node:http').request(f.base + route, { method: 'POST', headers: { Host: 'foreign.invalid', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end(JSON.stringify({ autoPublish: true }));
    });
    assert.equal(status, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.published.length, 0);
});
