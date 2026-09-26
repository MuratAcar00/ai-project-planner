const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { createApp } = require('../src/app');
const { ApprovalGate } = require('../src/services/approval-gate');
const { AutonomousProjectService } = require('../src/services/autonomous-project-service');
const { CODEX_BUDGET } = require('../src/autonomous/codex-budget');
const { runSummary } = require('../src/autonomous/presentation');
const { failureFingerprint, workspaceFingerprint } = require('../src/autonomous/repair-progress');
const { createTask, createPhase, createPlan } = require('../src/domain');
const { fixture, finish, deferred } = require('./autonomous-helpers');

async function setup(t, options = {}) {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: options.trusted !== false }), validate: options.validate });
  const app = createApp({ projectRepository: f.dependencies.projectRepository, executionService: f.dependencies.executionService,
    workspaceService: f.dependencies.workspaceService, autonomousService: f.service });
  const mode = app.locals.autonomousMode;
  await mode.initialize();
  t.after(() => mode.close());
  const id = 'repair-grant-run';
  const projectId = 'repair-grant-project';
  const baseTask = createTask({ id: 'base-task', title: 'Build', completed: true });
  await f.dependencies.projectRepository.create({ id: projectId, autonomousRunId: id, status: 'Needs attention', runs: [],
    plan: createPlan({ phases: [createPhase({ name: 'Build', tasks: [baseTask] })] }) });
  await f.dependencies.runRepository.create({ id, projectId, state: 'paused', resumeState: 'fixing', needsAttention: true,
    fixAttempts: 2, maxFixAttempts: options.maxFixAttempts || 3, activeFixTaskId: null,
    pendingFailure: { kind: 'validation', infrastructureError: false, message: 'Original assertion failed' },
    failureAnalysis: { category: 'validation', recoverable: true }, validationPassed: false, validationResults: [],
    pauseReason: 'Server restarted. Review interrupted work before explicitly resuming.',
    codexUsage: { codexCallsTotal: 5, buildCalls: 3, repairCalls: 2, failedCalls: 0 },
    events: [{ type: 'codex_budget_exhausted', budgetType: 'repair' }, { type: 'run_recovered' }] });
  const processCalls = [];
  f.service.executionProvider = 'codex';
  f.dependencies.executionService.providers.set('codex', { name: 'codex', requiresWorkspace: false, async executeTask(task, context) {
    processCalls.push(task.id);
    if (options.execute) return options.execute(task, context);
    await context.onExecutionStart(context.runId);
    return { success: true };
  } });
  const get = () => f.dependencies.runRepository.get(id);
  const patch = values => f.dependencies.runRepository.update(id, run => { Object.assign(run, values); return true; });
  return { ...f, id, projectId, app, mode, get, patch, processCalls };
}

async function serve(t, options) {
  const f = await setup(t, options);
  const server = f.app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/api/autonomous/${f.id}`;
  const post = (suffix, body = {}, headers = {}) => fetch(base + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  return { ...f, server, base, post };
}

test('repair grant is audited, preserves history and usage, and stays paused until explicit Resume', async t => {
  const f = await setup(t);
  const before = await f.get();
  assert.equal(await f.service.canGrantRepair(f.id), true);
  assert.equal(await f.service.canRecoverAttention(f.id), false);
  await assert.rejects(f.mode.manualControl(f.id, 'resume'), { status: 409 });
  const granted = await f.mode.manualControl(f.id, 'grantRepair');
  assert.equal(granted.state, 'paused');
  assert.equal(granted.resumeState, 'fixing');
  assert.equal(granted.needsAttention, false);
  assert.match(granted.pauseReason, /Explicit Resume/);
  assert.deepEqual(granted.codexUsage, before.codexUsage);
  assert.equal(granted.fixAttempts, before.fixAttempts);
  assert.equal(granted.maxFixAttempts, before.maxFixAttempts);
  assert.deepEqual(granted.pendingFailure, before.pendingFailure);
  assert.deepEqual(granted.events.slice(0, -1), before.events);
  assert.equal(granted.events.at(-1).type, 'operator_repair_granted');
  assert.equal(granted.events.at(-1).amount, 1);
  assert.equal(granted.operatorRepairGrant.status, 'available');
  assert.equal(granted.operatorRepairGrant.amount, 1);
  assert.equal(await f.service.canGrantRepair(f.id), false);
  assert.equal(runSummary(granted).canResume, true);
  assert.equal(f.service.jobs.size, 0);
  assert.deepEqual(f.processCalls, []);
  await f.mode.manualControl(f.id, 'resume');
  const done = await finish(f.service, f.id);
  assert.equal(done.state, 'completed');
  assert.equal(f.processCalls.length, 1);
  assert.equal(done.operatorRepairGrant.status, 'consumed');
  assert.equal(done.operatorRepairGrant.taskId, f.processCalls[0]);
  assert.equal(done.events.filter(item => item.type === 'operator_repair_grant_consumed').length, 1);
  assert.equal(done.codexUsage.repairCalls, 3);
  assert.equal(done.codexUsage.codexCallsTotal, 6);
  assert.equal(done.codexUsage.buildCalls, 3);
  assert.equal(done.fixAttempts, 3);
  assert.equal(CODEX_BUDGET.repairCalls, 2);
});

test('concurrent grant requests cannot accumulate more than one unused allowance', async t => {
  const f = await setup(t);
  const attempts = await Promise.allSettled([f.service.grantRepair(f.id), f.service.grantRepair(f.id), f.mode.manualControl(f.id, 'grantRepair')]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(item => item.status === 'rejected').every(item => item.reason.status === 409));
  const run = await f.get();
  assert.equal(run.events.filter(item => item.type === 'operator_repair_granted').length, 1);
  // Even if another stop is recorded, an outstanding grant cannot be stacked.
  await f.patch({ needsAttention: true, events: [...run.events, { type: 'codex_budget_exhausted', budgetType: 'repair' }] });
  await assert.rejects(f.service.grantRepair(f.id), { status: 409 });
});

test('one grant permits one repair and a subsequent repair requires a new reviewed grant', async t => {
  const f = await setup(t, { maxFixAttempts: 10, validate: () => ({ passed: false, checks: [{ name: 'tests', passed: false, output: 'Different assertion failed' }] }) });
  await f.mode.manualControl(f.id, 'grantRepair');
  await f.mode.manualControl(f.id, 'resume');
  const paused = await finish(f.service, f.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.needsAttention, true);
  assert.equal(paused.activeFixTaskId, null);
  assert.equal(paused.fixAttempts, 3);
  assert.equal(paused.codexUsage.repairCalls, 3);
  assert.equal(f.processCalls.length, 1);
  assert.equal(paused.events.at(-1).type, 'codex_budget_exhausted');
  await assert.rejects(f.mode.manualControl(f.id, 'resume'), { status: 409 });
  const next = await f.mode.manualControl(f.id, 'grantRepair');
  assert.notEqual(next.operatorRepairGrant.id, paused.operatorRepairGrant.id);
  assert.equal(next.operatorRepairGrant.amount, 1);
  assert.equal(next.operatorRepairGrant.repairCallsAtGrant, 3);
  assert.deepEqual(next.codexUsage, paused.codexUsage);
  assert.equal(next.state, 'paused');
  assert.equal(f.processCalls.length, 1);
});

test('concurrent execution reservations consume a grant once before provider startup', async t => {
  const entered = deferred(); const release = deferred();
  const f = await setup(t, { execute: async (task, context) => {
    entered.resolve();
    await release.promise;
    await context.onExecutionStart(context.runId);
    await context.onExecutionStart(context.runId);
    return { success: true };
  } });
  await f.service.grantRepair(f.id);
  const tasks = ['extra-a', 'extra-b'].map(id => createTask({ id, title: 'Repair', isFix: true }));
  await f.dependencies.projectRepository.update(f.projectId, project => { project.plan.phases.push(createPhase({ name: 'Repair', tasks })); return true; });
  const project = await f.dependencies.projectRepository.get(f.projectId);
  // Execution cannot spend the allowance while paused.
  assert.equal(await f.service.execute(f.id, project, tasks[0]), null);
  assert.equal((await f.get()).operatorRepairGrant.status, 'available');
  await f.patch({ state: 'fixing' });
  const attempts = tasks.map(task => f.service.execute(f.id, project, task));
  try {
    await entered.promise;
    const reserved = await f.get();
    assert.equal(reserved.operatorRepairGrant.status, 'consumed');
    assert.equal(reserved.codexUsage.repairCalls, 2);
  } finally { release.resolve(); }
  const results = await Promise.all(attempts);
  assert.equal(results.filter(result => result === null).length, 1);
  const run = await f.get();
  assert.equal(f.processCalls.length, 1);
  assert.equal(run.codexUsage.repairCalls, 3);
  assert.equal(run.events.filter(item => item.type === 'operator_repair_grant_consumed').length, 1);
});

test('unused grant survives restart and a consumed grant is not restored after a failed launch', async t => {
  const f = await setup(t, { execute: async () => { throw new Error('Unable to start Codex'); } });
  await f.service.grantRepair(f.id);
  const restarted = new AutonomousProjectService({ ...f.dependencies, executionProvider: 'codex' });
  await restarted.initialize();
  assert.equal((await f.get()).state, 'paused');
  assert.equal((await f.get()).operatorRepairGrant.status, 'available');
  assert.deepEqual(f.processCalls, []);
  await restarted.resume(f.id);
  const paused = await finish(restarted, f.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.needsAttention, true);
  assert.equal(paused.operatorRepairGrant.status, 'consumed');
  assert.equal(paused.codexUsage.repairCalls, 2);
  assert.equal(await restarted.canGrantRepair(f.id), false);
  assert.equal(f.processCalls.length, 1);
});

test('grant authorization is server-side and manual pipeline ownership is preserved', async t => {
  const f = await setup(t, { trusted: false });
  assert.equal(await f.service.canGrantRepair(f.id), false);
  await assert.rejects(f.mode.manualControl(f.id, 'grantRepair'), { status: 403 });
  f.service.approvalGate = new ApprovalGate({ allowCodexExecution: true });
  await f.mode.sessionRepository.create({ id: 'owner', status: 'stopped', currentRunId: f.id, projects: [] });
  await assert.rejects(f.mode.manualControl(f.id, 'grantRepair'), /Only manual/);
  await f.mode.sessionRepository.update('owner', session => { session.status = 'paused'; return true; });
  await assert.rejects(f.mode.manualControl(f.id, 'grantRepair'), /session is active/);
  assert.equal((await f.get()).operatorRepairGrant, undefined);
});

test('grant eligibility rejects other stops, active work, exhausted fix limits and unsafe failures', async t => {
  const f = await setup(t);
  const original = await f.get();
  const project = await f.dependencies.projectRepository.get(f.projectId);
  for (const patch of [
    { state: 'completed' }, { state: 'fixing' }, { state: 'failed' }, { state: 'abandoned' },
    { needsAttention: false }, { resumeState: 'testing' }, { activeFixTaskId: 'pending-fix' },
    { fixAttempts: 3 }, { pendingFailure: null }, { pendingFailure: { kind: 'setup' } },
    { pendingFailure: { kind: 'validation', infrastructureError: true } }, { failureAnalysis: { recoverable: false } },
    { codexUsage: { repairCalls: 1 } }, { events: [] }, { projectId: 'missing' },
    { events: [{ type: 'codex_budget_exhausted', budgetType: 'build' }] },
    { events: [...original.events, { type: 'repair_no_progress' }, { type: 'run_recovered' }] },
    { events: [...original.events, { type: 'run_paused', reason: 'Infrastructure unavailable' }] }
  ]) {
    await f.patch({ ...structuredClone(original), ...patch });
    assert.equal(await f.service.canGrantRepair(f.id), false, JSON.stringify(patch));
    await assert.rejects(f.service.grantRepair(f.id), { status: 409 });
  }
  await f.patch(original);
  f.service.jobs.set(f.id, Promise.resolve());
  assert.equal(await f.service.canGrantRepair(f.id), false);
  f.service.jobs.delete(f.id);
  for (const patch of [
    { autonomousRunId: 'different-owner' },
    { runs: [{ id: 'active-execution', status: 'running' }] },
    { plan: createPlan({ phases: [createPhase({ name: 'Work', tasks: [createTask({ title: 'Active', status: 'running' })] })] }) },
    { plan: createPlan({ phases: [createPhase({ name: 'Work', tasks: [createTask({ title: 'Fix', isFix: true })] })] }) }
  ]) {
    await f.dependencies.projectRepository.update(f.projectId, stored => { Object.assign(stored, structuredClone(project), patch); return true; });
    assert.equal(await f.service.canGrantRepair(f.id), false);
    await assert.rejects(f.service.grantRepair(f.id), { status: 409 });
  }
  await f.dependencies.projectRepository.update(f.projectId, stored => { Object.assign(stored, project, { runs: [{ id: 'settling', status: 'completed' }] }); return true; });
  f.dependencies.executionService.jobs.set('settling', Promise.resolve());
  assert.equal(await f.service.canGrantRepair(f.id), false);
  f.dependencies.executionService.jobs.delete('settling');
});

test('grant cannot bypass an unchanged failure and workspace even after restart hides the reason', async t => {
  const f = await setup(t);
  const workspace = await f.dependencies.workspaceService.getWorkspacePath(f.projectId);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(`${workspace}/app.js`, 'unchanged');
  const run = await f.get();
  await f.patch({ repairProgress: { failureFingerprint: failureFingerprint(run.pendingFailure), workspaceFingerprint: await workspaceFingerprint(workspace) } });
  assert.equal(await f.service.canGrantRepair(f.id), false);
  await assert.rejects(f.service.grantRepair(f.id), { status: 409 });
});

test('normal budgets and build limits remain unchanged and do not acquire grants', async t => {
  const f = await setup(t);
  await f.patch({ state: 'fixing', needsAttention: false, codexUsage: { repairCalls: 1, buildCalls: 3 } });
  assert.equal(await f.service.checkCodexBudget(f.id, 'repair'), true);
  assert.equal((await f.get()).operatorRepairGrant, undefined);
  assert.equal(await f.service.checkCodexBudget(f.id, 'build'), false);
  assert.equal((await f.get()).events.at(-1).budgetType, 'build');
  await f.patch({ state: 'fixing', codexUsage: { repairCalls: 2, buildCalls: 3 } });
  assert.equal(await f.service.checkCodexBudget(f.id, 'repair'), false);
  assert.equal((await f.get()).operatorRepairGrant, undefined);
  await f.service.grantRepair(f.id);
  await f.patch({ state: 'fixing' });
  assert.equal(await f.service.checkCodexBudget(f.id, 'build'), false);
  assert.equal((await f.get()).operatorRepairGrant.status, 'available');
  assert.deepEqual(CODEX_BUDGET, { buildCalls: 3, repairCalls: 2 });
});

test('grant API uses the trusted operator boundary and exposes the paused-to-Resume progression', async t => {
  const f = await serve(t);
  const before = await (await fetch(f.base)).json();
  assert.equal(before.canGrantRepair, true);
  assert.equal(before.canResume, false);
  assert.equal((await f.post('/resume')).status, 409);
  const response = await f.post('/grant-repair');
  assert.equal(response.status, 200);
  const granted = await response.json();
  assert.equal(granted.state, 'paused');
  assert.equal(granted.needsAttention, false);
  assert.equal(granted.canGrantRepair, false);
  assert.equal(granted.canResume, true);
  assert.deepEqual(f.processCalls, []);
  assert.equal((await f.post('/grant-repair')).status, 409);
  assert.equal((await f.post('/resume')).status, 202);
  assert.equal((await finish(f.service, f.id)).state, 'completed');
});

test('grant API rejects hostile Host, foreign/malformed Origin, cross-site requests and non-JSON', async t => {
  const f = await serve(t);
  let receivedHost;
  f.server.once('request', req => { receivedHost = req.headers.host; });
  const status = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/grant-repair', { method: 'POST', headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json' } }, response => {
      response.on('error', reject); response.on('end', () => resolve(response.statusCode)); response.resume();
    });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(receivedHost, 'attacker.invalid');
  assert.equal(status, 403);
  for (const headers of [
    { Origin: 'https://attacker.invalid' }, { Origin: 'malformed' }, { Origin: '' },
    { Origin: new URL(f.base).origin.replace('http:', 'https:') },
    { Origin: new URL(f.base).origin + '/path' }, { 'Sec-Fetch-Site': 'cross-site' }
  ]) assert.equal((await f.post('/grant-repair', {}, headers)).status, 403, JSON.stringify(headers));
  assert.equal((await f.post('/grant-repair', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.get()).operatorRepairGrant, undefined);
  assert.equal((await f.post('/grant-repair', {}, { Origin: new URL(f.base).origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('grant API accepts no configuration or browser authorization and returns 404 for missing runs', async t => {
  const f = await serve(t, { trusted: false });
  assert.equal((await (await fetch(f.base)).json()).canGrantRepair, false);
  for (const body of [{ amount: 2 }, { trusted: true }, { operator: true }, { approved: true }, { allowCodexExecution: true }, []]) {
    assert.equal((await f.post('/grant-repair', body)).status, 400);
  }
  assert.equal((await f.post('/grant-repair?amount=1')).status, 400);
  assert.equal((await f.post('/grant-repair')).status, 403);
  const missing = await fetch(f.base.replace(f.id, 'missing') + '/grant-repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 404);
  assert.equal((await f.get()).operatorRepairGrant, undefined);
});

test('UI shows Grant 1 Repair Attempt only with its capability and explains explicit Resume', async () => {
  const source = await fs.readFile('public/app.js', 'utf8');
  const context = { esc: value => String(value) };
  vm.runInNewContext(source.slice(source.indexOf('function controls('), source.indexOf('function card(')), context);
  const html = context.controls({ id: 'run', canGrantRepair: true, needsAttention: true });
  assert.match(html, /data-action="grant-repair">Grant 1 Repair Attempt/);
  assert.match(html, /stays paused until you press Resume/);
  assert.doesNotMatch(context.controls({ id: 'run', needsAttention: true }), /data-action="grant-repair"/);
  assert.doesNotMatch(context.controls({ id: 'run', canResume: true }), /data-action="grant-repair"/);
});
