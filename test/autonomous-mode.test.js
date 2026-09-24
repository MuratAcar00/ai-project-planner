const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { modeFixture } = require('./autonomous-mode-helpers');
const { validateSessionConfig } = require('../src/services/autonomous-mode-service');

test('session defaults and strict bounded configuration', () => {
  assert.deepEqual(validateSessionConfig(), { maxProjects: 5, stopOnNeedsAttention: true, autoPublish: false });
  for (const maxProjects of [0, 11, -1, 1.5, '5', null, Infinity]) assert.throws(() => validateSessionConfig({ maxProjects }), /maxProjects/);
  for (const input of [null, [], { command: 'node' }, { workspace: '/tmp' }, { provider: 'codex' }, { autoPublish: 'yes' }, { stopOnNeedsAttention: null }]) assert.throws(() => validateSessionConfig(input));
  assert.equal(validateSessionConfig({ maxProjects: 10 }).maxProjects, 10);
});

test('start persists a session and concurrent Start rejects the second with 409', async t => {
  const f = await modeFixture(t);
  const results = await Promise.allSettled([f.service.start(), f.service.start()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'sessions.json')))[0];
  assert.equal(stored.status, 'running'); assert.equal(stored.maxProjects, 5); assert.equal(stored.autoPublish, false);
  assert.equal(stored.completedProjects, 0); assert.ok(stored.id && stored.createdAt && stored.startedAt);
});

test('smoke: three sequential unique mock projects complete at 3/3 without duplicate starts', async t => {
  const f = await modeFixture(t);
  const session = await f.service.start({ maxProjects: 3 });
  await f.service.tick();
  await Promise.all(Array.from({ length: 8 }, () => f.service.tick()));
  assert.equal(f.calls.length, 1);
  for (let n = 1; n <= 3; n++) {
    await f.settle(); await f.service.tick();
    const dto = await f.service.snapshot();
    assert.equal(dto.session.completedProjects, n);
    assert.equal(f.calls.length, Math.min(3, n + 1));
  }
  const done = await f.service.snapshot();
  assert.equal(done.session.id, session.id); assert.equal(done.session.status, 'completed');
  assert.equal(done.session.progress, 100); assert.equal(done.session.projects.length, 3);
  assert.equal(new Set(done.session.projects.map(p => p.projectId)).size, 3);
  assert.equal(f.maxConcurrent(), 1); assert.deepEqual(f.published, []);
  for (let n = 0; n < 5; n++) await f.service.tick();
  assert.equal(f.calls.length, 3);
});

test('smoke: pause drains current task, resume preserves session and progress', async t => {
  const f = await modeFixture(t);
  const session = await f.service.start({ maxProjects: 2 }); await f.service.tick();
  await f.settle(); await f.service.tick();
  assert.equal((await f.service.request('pause')).status, 'pausing');
  await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'pausing');
  assert.equal(f.dependencies.autonomousService.jobs.size, 1);
  await assert.rejects(() => f.service.request('resume'), /paused or reviewed/);
  f.dependencies.autonomousService.jobs.clear();
  await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'paused');
  await f.service.tick(); assert.equal(f.calls.length, 2);
  const resumed = await f.service.request('resume');
  assert.equal(resumed.id, session.id); assert.equal(resumed.completedProjects, 1);
  assert.equal(f.calls.length, 2);
  await f.settle(); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'completed');
});

test('pause and stop before first project never start a pipeline', async t => {
  for (const action of ['pause', 'stop']) {
    const f = await modeFixture(t); await f.service.start(); await f.service.request(action); await f.service.tick();
    assert.equal((await f.service.snapshot()).session.status, action === 'pause' ? 'paused' : 'stopped');
    assert.equal(f.calls.length, 0);
  }
});

test('Stop waits for the current operation without killing it and never starts another project', async t => {
  const f = await modeFixture(t); await f.service.start(); await f.service.tick();
  const stopped = await f.service.request('stop'); assert.equal(stopped.status, 'stopping');
  await f.service.tick(); assert.equal((await f.service.snapshot()).session.status, 'stopping');
  f.dependencies.autonomousService.jobs.clear(); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'stopped');
  await f.service.tick(); assert.equal(f.calls.length, 1);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
  await assert.rejects(() => f.service.request('resume'), /No controllable/);
});

test('failed and infrastructure runs halt by default and cannot resume without recovery', async t => {
  for (const state of ['failed', 'paused']) {
    const f = await modeFixture(t); await f.service.start(); await f.service.tick();
    await f.settle(state, { needsAttention: true, failureAnalysis: { category: 'infrastructure' }, error: 'RAW SECRET STDERR' });
    await f.service.tick();
    const dto = await f.service.snapshot();
    assert.equal(dto.session.status, 'needs_attention'); assert.equal(dto.session.completedProjects, 0);
    assert.equal(JSON.stringify(dto).includes('RAW SECRET'), false);
    await assert.rejects(() => f.service.request('resume'), /trusted recovery/);
    for (let n = 0; n < 10; n++) await f.service.tick();
    assert.equal(f.calls.length, 1);
    await f.settle('completed', { needsAttention: false });
    await f.service.request('resume'); await f.service.tick(); assert.equal(f.calls.length, 2);
  }
});

test('stopOnNeedsAttention OFF continues terminal application failures but keeps attempt limit', async t => {
  const f = await modeFixture(t); await f.service.start({ maxProjects: 2, stopOnNeedsAttention: false }); await f.service.tick();
  await f.settle('failed', { needsAttention: true, failureAnalysis: { category: 'tests' } }); await f.service.tick();
  assert.equal(f.calls.length, 2);
  await f.settle(); await f.service.tick();
  const dto = await f.service.snapshot();
  assert.equal(dto.session.status, 'needs_attention'); assert.equal(dto.session.completedProjects, 1); assert.equal(dto.session.failedProjects, 1);
  await f.service.tick(); assert.equal(f.calls.length, 2);
});

test('stopOnNeedsAttention OFF never bypasses infrastructure or novelty exhaustion', async t => {
  const f = await modeFixture(t); await f.service.start({ stopOnNeedsAttention: false }); await f.service.tick();
  await f.settle('paused', { needsAttention: true, pauseReason: 'No unique eligible idea found within the candidate batch limit.' }); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'needs_attention'); assert.equal(f.calls.length, 1);
});

test('autoPublish ON delegates only completed validated project IDs to injected publisher', async t => {
  const f = await modeFixture(t); await f.service.start({ maxProjects: 1, autoPublish: true }); await f.service.tick();
  assert.deepEqual(f.published, []);
  await f.settle(); await f.service.tick(); await f.service.publishJob; await f.service.tick();
  assert.deepEqual(f.published, ['project-1']); assert.equal((await f.service.snapshot()).session.status, 'completed');
});

test('publish failure stops sequence without silent retry and manual reconciliation permits resume', async t => {
  const f = await modeFixture(t, { publish: () => { throw new Error('RAW TOKEN'); }, published: true });
  await f.service.start({ maxProjects: 2, autoPublish: true }); await f.service.tick(); await f.settle();
  await f.service.tick(); await f.service.publishJob;
  assert.equal((await f.service.snapshot()).session.status, 'needs_attention');
  for (let n = 0; n < 5; n++) await f.service.tick();
  assert.equal(f.published.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(await f.service.snapshot()).includes('RAW TOKEN'), false);
  await f.service.request('resume'); await f.service.tick(); assert.equal(f.calls.length, 2);
});

test('Pause/Stop can be requested while publishing is in flight', async t => {
  let resolve;
  const publishing = new Promise(r => { resolve = r; });
  const f = await modeFixture(t, { publish: () => publishing });
  t.after(() => resolve({ publishStatus: 'published' }));
  await f.service.start({ autoPublish: true }); await f.service.tick(); await f.settle(); await f.service.tick();
  assert.equal((await f.service.request('stop')).status, 'stopping'); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'stopping');
  resolve({ publishStatus: 'published' }); await f.service.publishJob; await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'stopped'); assert.equal(f.calls.length, 1);
});

test('restart reconciles completed current run once and requires explicit Resume', async t => {
  const f = await modeFixture(t); const first = await f.service.start({ maxProjects: 2 }); await f.service.tick(); await f.settle();
  const restarted = await f.restart();
  assert.equal((await restarted.snapshot()).session.status, 'paused');
  assert.equal((await restarted.snapshot()).session.completedProjects, 1); assert.equal(f.calls.length, 1);
  await restarted.request('resume'); await restarted.tick();
  assert.equal(f.calls.length, 2); assert.equal((await restarted.snapshot()).session.id, first.id);
});

test('restart paused run stays paused and resumes its existing ID', async t => {
  const f = await modeFixture(t); await f.service.start(); await f.service.tick(); await f.service.request('pause'); f.dependencies.autonomousService.jobs.clear(); await f.service.tick();
  const restarted = await f.restart(); assert.equal((await restarted.snapshot()).session.status, 'paused');
  await restarted.request('resume'); await restarted.tick(); assert.equal(f.calls.length, 1);
});

test('restart ambiguous run and missing reservation require attention, never duplicate execution', async t => {
  for (const missing of [false, true]) {
    const f = await modeFixture(t); await f.service.start(); await f.service.tick();
    if (missing) await f.dependencies.autonomousService.runRepository.delete('run-1');
    const restarted = await f.restart({ crash: true });
    assert.equal((await restarted.snapshot()).session.status, 'needs_attention');
    await restarted.tick(); assert.equal(f.calls.length, 1);
  }
});

test('restart links a persisted reservation to the existing completed run by requestId', async t => {
  const f = await modeFixture(t); const session = await f.service.start(); await f.service.tick(); await f.settle();
  await f.dependencies.sessionRepository.update(session.id, stored => { stored.currentRunId = null; stored.projects[0].runId = null; return true; });
  const restarted = await f.restart();
  const dto = await restarted.snapshot(); assert.equal(dto.session.currentRunId, 'run-1'); assert.equal(dto.session.completedProjects, 1);
  assert.equal(f.calls.length, 1);
});

test('manual start and session start share serialization; manual controls cannot bypass session pause', async t => {
  const f = await modeFixture(t); await f.service.start();
  await assert.rejects(() => f.service.manualStart({}), error => error.status === 409);
  await f.service.tick(); await assert.rejects(() => f.service.manualControl('run-1', 'resume'), /Autonomous Mode controls/);
  const g = await modeFixture(t); await g.service.manualStart({ requestId: 'manual' });
  await assert.rejects(() => g.service.start(), /existing autonomous run/);
});

test('manual mode works after completed/stopped sessions', async t => {
  for (const status of ['completed', 'stopped']) {
    const f = await modeFixture(t); await f.service.start({ maxProjects: 1 });
    if (status === 'stopped') { await f.service.request('stop'); await f.service.tick(); }
    else { await f.service.tick(); await f.settle(); await f.service.tick(); }
    const result = await f.service.manualStart({ requestId: 'manual-next' });
    assert.equal(result.duplicate, false);
  }
});

test('real pipeline novelty is reused across session runs and exhaustion never accepts duplicates', async t => {
  const { fixture, finish } = require('./autonomous-helpers');
  const { AutonomousModeService } = require('../src/services/autonomous-mode-service');
  const { JsonFactorySessionRepository } = require('../src/repositories/json-factory-session-repository');
  const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
  const ideas = await new TemplateIdeaProvider().generateIdeas();
  const f = await fixture(t, { maxIdeaBatches: 1, ideaProvider: { async generateIdeas() { return ideas; } } });
  // Existing products consume two of the three recipes; fake execution only.
  for (const idea of ideas.slice(0, 2)) await f.dependencies.projectRepository.create({ id: idea.id, name: idea.name, idea, plan: { phases: [] }, runs: [] });
  const mode = new AutonomousModeService({ autonomousService: f.service, projectRepository: f.dependencies.projectRepository,
    sessionRepository: new JsonFactorySessionRepository(path.join(f.directory, 'sessions.json')), pollMs: 60000 });
  t.after(() => mode.close());
  await mode.start({ maxProjects: 2 }); await mode.tick();
  let session = await mode.active(); await finish(f.service, session.currentRunId); await mode.tick();
  session = await mode.active(); await finish(f.service, session.currentRunId); await mode.tick();
  const dto = await mode.snapshot();
  assert.equal(dto.session.status, 'needs_attention'); assert.equal(dto.session.completedProjects, 1);
  assert.equal((await f.dependencies.projectRepository.list()).length, 3);
  assert.equal(f.calls.length, 4); // Exactly one product's four fake tasks; no duplicate product.
  await mode.close();
});

test('shutdown requests a safe checkpoint without killing or replacing an active task', async t => {
  const f = await modeFixture(t); await f.service.start(); await f.service.tick();
  await f.service.close();
  assert.equal(f.dependencies.autonomousService.jobs.size, 1);
  const persisted = (await f.dependencies.sessionRepository.list())[0];
  assert.equal(persisted.status, 'pausing');
  assert.equal((await f.dependencies.autonomousService.runRepository.get('run-1')).state, 'paused');
  await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('manual task execution cannot overlap an active session, including paused sessions', async t => {
  const f = await modeFixture(t); let executed = 0;
  await f.service.manualTask(() => { executed++; }); assert.equal(executed, 1);
  await f.service.start(); await f.service.request('pause'); await f.service.tick();
  await assert.rejects(() => f.service.manualTask(() => { executed++; }), /owns the execution/);
  assert.equal(executed, 1);
});

test('auto-publish refuses unvalidated completion and never invokes publisher', async t => {
  const f = await modeFixture(t); await f.service.start({ autoPublish: true }); await f.service.tick();
  await f.settle('completed', { validationPassed: false }); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'needs_attention'); assert.equal(f.published.length, 0);
});

test('restart with interrupted publishing requires manual reconciliation, not another push', async t => {
  const f = await modeFixture(t); const session = await f.service.start({ autoPublish: true }); await f.service.tick(); await f.settle();
  await f.dependencies.sessionRepository.update(session.id, stored => { stored.projects[0].publishStatus = 'publishing'; return true; });
  const restarted = await f.restart({ crash: true });
  assert.equal((await restarted.snapshot()).session.status, 'needs_attention');
  await restarted.tick(); assert.equal(f.published.length, 0);
  await assert.rejects(() => restarted.request('resume'), /publication manually/);
});

test('current run project ownership mismatch stops before another pipeline starts', async t => {
  const f = await modeFixture(t); await f.service.start(); await f.service.tick(); await f.settle();
  await f.dependencies.projectRepository.update('project-1', stored => { stored.autonomousRunId = 'foreign'; return true; });
  await f.service.tick(); assert.equal((await f.service.snapshot()).session.status, 'needs_attention'); assert.equal(f.calls.length, 1);
});

test('stopOnNeedsAttention OFF does not guess that an unknown failed run is an application defect', async t => {
  const f = await modeFixture(t); await f.service.start({ stopOnNeedsAttention: false }); await f.service.tick();
  await f.settle('failed', { needsAttention: true }); await f.service.tick();
  assert.equal((await f.service.snapshot()).session.status, 'needs_attention'); assert.equal(f.calls.length, 1);
});
