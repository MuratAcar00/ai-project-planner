const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createApp } = require('../src/app');
const { ApprovalGate } = require('../src/services/approval-gate');
const { fixture, finish } = require('./autonomous-helpers');

async function setup(t, trusted = true, serve = true) {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: trusted }) });
  const app = createApp({ projectRepository: f.dependencies.projectRepository, executionService: f.dependencies.executionService,
    workspaceService: f.dependencies.workspaceService, autonomousService: f.service });
  await app.locals.autonomousMode.initialize();
  const { run } = await f.service.start({ platformPreference: 'web' });
  await finish(f.service, run.id);
  await f.dependencies.runRepository.update(run.id, stored => {
    Object.assign(stored, { state: 'paused', resumeState: 'fixing', needsAttention: true,
      pauseReason: 'Server restarted. Review interrupted work before explicitly resuming.',
      pendingFailure: { kind: 'validation', infrastructureError: false, message: 'Assertion failed' },
      failureAnalysis: { category: 'validation', recoverable: true }, fixAttempts: 2, maxFixAttempts: 3,
      validationPassed: false, activeFixTaskId: null });
    stored.events.push({ type: 'run_recovered' });
    return true;
  });
  if (!serve) {
    t.after(() => app.locals.autonomousMode.close());
    return { ...f, app, id: run.id };
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await app.locals.autonomousMode.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/autonomous/${run.id}`;
  return { ...f, app, server, id: run.id, base,
    post: (suffix, body = {}, headers = {}) => fetch(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}

test('trusted review acknowledges a recoverable restart checkpoint without execution, then normal Resume works', async t => {
  const f = await setup(t);
  const before = await f.dependencies.runRepository.get(f.id);
  const calls = f.calls.length;
  assert.equal((await f.post('/resume')).status, 409);
  await assert.rejects(f.app.locals.autonomousMode.manualControl(f.id, 'resume'), /trusted operator review/);
  const dto = await (await fetch(f.base)).json();
  assert.equal(dto.canRecover, true);
  assert.equal(dto.canResume, false);
  assert.equal(dto.canRetryValidation, false);
  assert.equal((await f.post('/retry-validation')).status, 409);
  const response = await f.post('/recover');
  assert.equal(response.status, 200);
  const recovered = await response.json();
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.needsAttention, false);
  assert.equal(recovered.canRecover, false);
  assert.equal(recovered.canResume, true);
  const stored = await f.dependencies.runRepository.get(f.id);
  assert.equal(stored.resumeState, 'fixing');
  assert.deepEqual(stored.pendingFailure, before.pendingFailure);
  assert.equal(stored.fixAttempts, 2);
  assert.deepEqual(stored.codexUsage, before.codexUsage);
  assert.match(stored.pauseReason, /Explicit Resume/);
  assert.equal(stored.events.at(-1).type, 'operator_review_acknowledged');
  assert.equal(stored.events.at(-1).resumeState, 'fixing');
  assert.equal(f.service.jobs.size, 0);
  assert.equal(f.calls.length, calls);
  assert.equal((await f.post('/recover')).status, 409);
  assert.equal((await f.post('/resume')).status, 202);
  assert.equal((await finish(f.service, f.id)).state, 'completed');
  assert.ok(f.calls.length > calls);
});

test('operator capability defaults to denied and browser data cannot authorize recovery', async t => {
  const f = await setup(t, false);
  assert.equal((await (await fetch(f.base)).json()).canRecover, false);
  assert.equal((await f.post('/recover')).status, 403);
  await assert.rejects(f.service.acknowledgeAttention(f.id), { status: 403 });
  for (const body of [{ trusted: true }, { operator: true }, { approved: true }, { allowCodexExecution: true }, { resumeState: 'testing' }, []]) {
    assert.equal((await f.post('/recover', body)).status, 400);
  }
  assert.equal((await f.post('/recover?trusted=true')).status, 400);
  assert.equal((await f.dependencies.runRepository.get(f.id)).needsAttention, true);
  const missing = await fetch(f.base.replace(f.id, 'missing') + '/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 404);
});

test('operator recovery retains localhost, origin and JSON protections', async t => {
  const f = await setup(t);
  let receivedHost;
  f.server.once('request', request => { receivedHost = request.headers.host; });
  // Use raw HTTP because fetch can replace a caller-supplied Host header.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/recover', {
      method: 'POST', headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json' }
    }, response => {
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode));
      response.resume();
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(receivedHost, 'attacker.invalid', 'The server must receive the hostile Host header unchanged');
  assert.equal(hostileHostStatus, 403, 'Expected 403 for headers: {"Host":"attacker.invalid"}');
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'malformed' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await f.post('/recover', {}, headers);
    assert.equal(response.status, 403, `Expected 403 for headers: ${JSON.stringify(headers)}`);
  }
  assert.equal((await f.post('/recover', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.dependencies.runRepository.get(f.id)).needsAttention, true);
  assert.equal((await f.post('/recover', {}, { Origin: new URL(f.base).origin })).status, 200);
});

test('recovery rejects unsafe checkpoints, live work and session-owned runs', async t => {
  const f = await setup(t);
  const original = await f.dependencies.runRepository.get(f.id);
  const variants = [
    { state: 'completed' }, { state: 'executing' }, { state: 'failed' }, { state: 'abandoned' },
    { needsAttention: false }, { resumeState: 'testing' }, { events: [] },
    { pendingFailure: { kind: 'setup' } },
    { pendingFailure: { kind: 'validation', infrastructureError: true } },
    { failureAnalysis: { recoverable: false } }, { projectId: 'missing' },
    { fixAttempts: 3 }, { codexUsage: { repairCalls: 2 } },
    ...['codex_budget_exhausted', 'repair_no_progress'].map(type => ({ events: [{ type }, { type: 'run_recovered' }] }))
  ];
  for (const variant of variants) {
    await f.dependencies.runRepository.update(f.id, stored => { Object.assign(stored, structuredClone(original), variant); return true; });
    assert.equal((await (await fetch(f.base)).json()).canRecover, false, JSON.stringify(variant));
    assert.equal((await f.post('/recover')).status, 409, JSON.stringify(variant));
  }
  await f.dependencies.runRepository.update(f.id, stored => { Object.assign(stored, original); return true; });
  f.service.jobs.set(f.id, Promise.resolve());
  assert.equal((await f.post('/recover')).status, 409);
  f.service.jobs.delete(f.id);
  await f.dependencies.projectRepository.update(original.projectId, project => { project.plan.phases[0].tasks[0].status = 'running'; return true; });
  assert.equal((await f.post('/recover')).status, 409);
  await f.dependencies.projectRepository.update(original.projectId, project => { project.plan.phases[0].tasks[0].status = 'completed'; return true; });
  await f.app.locals.autonomousMode.sessionRepository.create({ id: 'owner', status: 'stopped', currentRunId: f.id, projects: [] });
  assert.equal((await (await fetch(f.base)).json()).canRecover, false);
  assert.equal((await f.post('/recover')).status, 409);
});

test('UI offers explicit recovery without chaining Resume', async () => {
  const source = await fs.readFile('public/app.js', 'utf8');
  assert.match(source, /run.canRecover \? .*data-action="recover">Review &amp; Recover/);
  assert.match(source, /run stays paused until you press Resume/);
  assert.match(source, /finally \{ busy = false; await refresh\(\); \}/);
});

test('service recovery is serialized, audited and does not launch until explicit Resume', async t => {
  const f = await setup(t, true, false);
  const mode = f.app.locals.autonomousMode;
  assert.equal(await f.service.canRecoverAttention(f.id), true);
  await assert.rejects(mode.manualControl(f.id, 'resume'), { status: 409 });
  const calls = f.calls.length;
  const results = await Promise.allSettled([mode.manualControl(f.id, 'recover'), mode.manualControl(f.id, 'recover')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  const run = results[0].value;
  assert.equal(run.state, 'paused');
  assert.equal(run.resumeState, 'fixing');
  assert.equal(run.needsAttention, false);
  assert.equal(run.events.at(-1).type, 'operator_review_acknowledged');
  assert.equal(f.service.jobs.size, 0);
  assert.equal(f.calls.length, calls);
  await mode.manualControl(f.id, 'resume');
  assert.equal((await finish(f.service, f.id)).state, 'completed');
});

test('service recovery refuses untrusted server capability', async t => {
  const f = await setup(t, false, false);
  assert.equal(await f.service.canRecoverAttention(f.id), false);
  await assert.rejects(f.app.locals.autonomousMode.manualControl(f.id, 'recover'), { status: 403 });
  assert.equal((await f.dependencies.runRepository.get(f.id)).needsAttention, true);
});

test('service eligibility preserves infrastructure, budget, no-progress and ownership blockers', async t => {
  const f = await setup(t, true, false);
  const original = await f.dependencies.runRepository.get(f.id);
  for (const patch of [
    { state: 'completed' }, { state: 'executing' }, { state: 'failed' },
    { pendingFailure: { kind: 'validation', infrastructureError: true } },
    { failureAnalysis: { recoverable: false } }, { codexUsage: { repairCalls: 2 } },
    { events: [{ type: 'repair_no_progress' }, { type: 'run_recovered' }] }
  ]) {
    await f.dependencies.runRepository.update(f.id, run => { Object.assign(run, structuredClone(original), patch); return true; });
    assert.equal(await f.service.canRecoverAttention(f.id), false);
    await assert.rejects(f.service.acknowledgeAttention(f.id), { status: 409 });
  }
  await f.dependencies.runRepository.update(f.id, run => { Object.assign(run, original); return true; });
  const mode = f.app.locals.autonomousMode;
  await mode.sessionRepository.create({ id: 'session-owner', status: 'stopped', currentRunId: f.id, projects: [] });
  await assert.rejects(mode.manualControl(f.id, 'recover'), /Only manual/);
  await mode.sessionRepository.update('session-owner', session => { session.status = 'paused'; return true; });
  await assert.rejects(mode.manualControl(f.id, 'recover'), /session is active/);
});
