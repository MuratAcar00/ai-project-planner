const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { fixture, finish, deferred } = require('./autonomous-helpers');

async function serverFixture(t, options) {
  const f = await fixture(t, options);
  const server = createApp({ projectRepository: f.dependencies.projectRepository, executionService: f.dependencies.executionService,
    workspaceService: f.dependencies.workspaceService, autonomousService: f.service }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body = {}, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...f, base, post };
}

test('autonomous API responds 202 while generation is pending, with duplicate and pause controls', async t => {
  const entered = deferred(); const release = deferred();
  const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
  const f = await serverFixture(t, { ideaProvider: { async generateIdeas(config) { entered.resolve(); await release.promise; return new TemplateIdeaProvider().generateIdeas(config); } } });
  await f.service.initialize();
  try {
    const response = await f.post('/api/autonomous/start', { requestId: 'api-run', platformPreference: 'web' });
    assert.equal(response.status, 202);
    const { run } = await response.json();
    assert.equal(run.platformPreference, 'web');
    const persistedRun = await f.dependencies.runRepository.get(run.id);
    assert.equal(persistedRun.platformPreference, 'web');
    assert.equal(persistedRun.config.platformPreference, 'web');
    await entered.promise;
    assert.equal(f.calls.length, 0);
    assert.equal((await (await f.post('/api/autonomous/start', { requestId: 'api-run' })).json()).duplicate, true);
    assert.equal((await f.post(`/api/autonomous/${run.id}/pause`)).status, 202);
    assert.equal((await f.post(`/api/autonomous/${run.id}/resume`)).status, 409);
    release.resolve(); await finish(f.service, run.id);
    assert.equal((await (await fetch(`${f.base}/api/autonomous/${run.id}`)).json()).state, 'paused');
    assert.equal((await f.post(`/api/autonomous/${run.id}/resume`)).status, 202);
    const done = await finish(f.service, run.id);
    assert.equal(done.state, 'completed');
    const events = await (await fetch(`${f.base}/api/autonomous/${run.id}/events`)).json();
    assert.ok(events.some(event => event.type === 'project_completed'));
    const project = await f.dependencies.projectRepository.get(done.projectId);
    const taskId = project.plan.phases[0].tasks[0].id;
    assert.equal((await f.post(`/api/projects/${project.id}/tasks/${taskId}/run`)).status, 409);
    assert.equal((await fetch(`${f.base}/api/projects/${project.id}/tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"completed":false}' })).status, 409);
    assert.equal((await fetch(`${f.base}/api/projects/${project.id}`, { method: 'DELETE' })).status, 409);
  } finally {
    release.resolve();
    await Promise.all([...f.service.jobs.values()]);
  }
});

test('autonomous API rejects shell/path/provider/approval input, cross-origin requests and malformed JSON', async t => {
  const f = await serverFixture(t);
  for (const body of [{ command: 'rm' }, { workspacePath: '/tmp' }, { provider: 'codex' }, { allowCodexExecution: true }, { maxFixAttempts: 100 }, { platformPreference: 'Flutter' }, { platformPreference: 'desktop' }, { platformPreference: null }, [], null]) assert.equal((await f.post('/api/autonomous/start', body)).status, 400);
  assert.equal((await f.post('/api/autonomous/start', {}, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await fetch(`${f.base}/api/autonomous/start`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${f.base}/api/autonomous/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${f.base}/api/autonomous/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(110000) }) })).status, 413);
  for (const suffix of ['', '/events']) assert.equal((await fetch(`${f.base}/api/autonomous/missing${suffix}`)).status, 404);
  for (const action of ['pause', 'resume', 'abandon']) assert.equal((await f.post(`/api/autonomous/missing/${action}`)).status, 404);
  assert.equal((await f.dependencies.runRepository.list()).length, 0);
});

test('manual abandon endpoint requires settled paused run and preserves its history', async t => {
  const f = await serverFixture(t);
  await f.service.initialize();
  const paused = { id: 'manual-abandon', state: 'paused', resumeState: 'executing', projectId: null, needsAttention: false,
    codexUsage: { codexCallsTotal: 2, buildCalls: 1, repairCalls: 1, failedCalls: 0 },
    events: [{ id: 'before', type: 'run_paused', timestamp: '2026-01-01T00:00:00.000Z', runId: 'manual-abandon', reason: 'Paused by user.' }] };
  await f.dependencies.runRepository.create(paused);
  const before = await f.dependencies.runRepository.get(paused.id);
  const response = await f.post(`/api/autonomous/${paused.id}/abandon`);
  assert.equal(response.status, 202);
  const dto = await response.json();
  assert.equal(dto.state, 'abandoned');
  assert.equal(dto.blocksNewRun, false);
  assert.equal(dto.canResume, false);
  assert.equal(dto.canPause, false);
  const stored = await f.dependencies.runRepository.get(paused.id);
  assert.equal(stored.state, 'abandoned');
  assert.deepEqual(stored.codexUsage, before.codexUsage);
  assert.deepEqual(stored.events[0], before.events[0]);
  assert.equal(stored.events.at(-1).type, 'run_abandoned');
  await f.dependencies.runRepository.create({ id: 'active-manual-run', state: 'executing', projectId: null, events: [], codexUsage: {} });
  assert.equal((await f.post('/api/autonomous/active-manual-run/abandon')).status, 409);
});

test('manual start ignores preserved non-resumable setup failure but retains active-run protection', async t => {
  const entered = deferred(); const release = deferred();
  const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
  const f = await serverFixture(t, { ideaProvider: { async generateIdeas(config) { entered.resolve(); await release.promise; return new TemplateIdeaProvider().generateIdeas(config); } } });
  await f.service.initialize();
  const historical = { id: 'autonomous-old-setup', state: 'paused', needsAttention: true, projectId: null,
    pendingFailure: { kind: 'setup', category: 'infrastructure', message: 'Flutter package name rejected.' },
    config: { requestId: 'old-mobile-run', platformPreference: 'mobile' }, platformPreference: 'mobile',
    codexUsage: { codexCallsTotal: 0, buildCalls: 0, repairCalls: 0, failedCalls: 0 }, events: [{ type: 'workspace_setup_failed', reason: 'Flutter package name rejected.' }] };
  await f.dependencies.runRepository.create(historical);
  const before = await f.dependencies.runRepository.get(historical.id);
  try {
    const started = await f.post('/api/autonomous/start', { requestId: 'new-mobile-run', platformPreference: 'mobile' });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).duplicate, false);
    await entered.promise;
    assert.deepEqual(await f.dependencies.runRepository.get(historical.id), before);
    const blocked = await f.post('/api/autonomous/start', { requestId: 'third-run' });
    assert.equal(blocked.status, 202);
    const response = await blocked.json();
    assert.equal(response.duplicate, true);
    assert.notEqual(response.run.id, historical.id);
  } finally {
    release.resolve();
    await Promise.all([...f.service.jobs.values()]);
  }
});
