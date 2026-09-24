const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, finish, deferred } = require('./autonomous-helpers');
const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
const { IdeaEvaluator } = require('../src/services/idea-evaluator');
const { ApprovalGate } = require('../src/services/approval-gate');
const { AutonomousProjectService, validateStart, fixLimit } = require('../src/services/autonomous-project-service');
const { transition } = require('../src/autonomous/state');
const { allTasks } = require('../src/services/execution-service');
const { createTask, createPhase, createPlan } = require('../src/domain');
const { CodexExecutionProvider } = require('../src/providers/codex-execution-provider');

test('idea provider produces multiple complete independent candidates', async () => {
  const provider = new TemplateIdeaProvider();
  const ideas = await provider.generateIdeas();
  assert.equal(ideas.length, 3);
  for (const idea of ideas) for (const key of ['id', 'name', 'oneLinePitch', 'targetUser', 'problem', 'solution', 'coreFeatures', 'monetization', 'complexity', 'estimatedTasks', 'generatedAt']) assert.ok(idea[key]);
  ideas[0].coreFeatures.push('mutation');
  assert.equal((await provider.generateIdeas())[0].coreFeatures.length, 4);
  await assert.rejects(() => provider.generateIdeas({ candidateCount: 20 }));
});

test('evaluation scores feasibility plus novelty and diversity criteria, excludes paid/external ideas and breaks ties deterministically', async () => {
  const evaluator = new IdeaEvaluator();
  const ideas = await new TemplateIdeaProvider().generateIdeas();
  const result = evaluator.select(ideas);
  assert.equal(result.evaluations[0].score <= 116, true);
  assert.equal(Object.keys(result.evaluations[0].criteria).length, 10);
  assert.deepEqual(evaluator.select(ideas).selected, result.selected);
  assert.equal(evaluator.evaluate({ ...ideas[0], paidApiRequired: true }).eligible, false);
  assert.equal(evaluator.evaluate({ ...ideas[0], externalDependencies: ['payment'] }).eligible, false);
  assert.equal(evaluator.select([{ ...ideas[0], complexity: 5 }]).selected, null);
  assert.throws(() => evaluator.evaluate({ ...ideas[0], usefulness: 99 }));
});

test('config and state machine reject unsafe inputs and invalid transitions', () => {
  for (const input of [{ command: 'sh' }, { workspace: '/tmp' }, { provider: 'codex' }, { candidateCount: 4 }, [], null, { requestId: '../a' }]) assert.throws(() => validateStart(input));
  assert.equal(fixLimit(0), 0);
  for (const value of [-1, 11, 'invalid', 1.5]) assert.throws(() => fixLimit(value));
  assert.throws(() => transition({ state: 'idle' }, 'completed'));
  assert.throws(() => transition({ state: 'completed' }, 'executing'));
});

test('successful run creates requirements and plan, executes dependencies, validates then completes', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  const project = await f.dependencies.projectRepository.get(done.projectId);
  assert.equal(project.status, 'Completed');
  assert.equal(project.requirements.items.length, 4);
  assert.equal(project.plan.provider, 'autonomous');
  assert.equal(project.autonomousRunId, done.id);
  const tasks = allTasks(project);
  assert.deepEqual(f.calls, tasks.map(task => task.id));
  assert.ok(tasks.every(task => task.completed && task.startedAt && task.completedAt));
  assert.equal(tasks[0].dependencies.length, 0);
  assert.equal(tasks[1].dependencies[0], tasks[0].id);
  assert.equal(f.validationCount(), 1);
  const types = done.events.map(event => event.type);
  for (const type of ['idea_generated', 'idea_selected', 'project_created', 'plan_created', 'task_started', 'task_completed', 'validation_started', 'validation_passed', 'project_completed']) assert.ok(types.includes(type));
  assert.ok(types.indexOf('validation_passed') < types.indexOf('project_completed'));
  assert.ok(done.events.every(event => event.timestamp && event.runId === done.id));
  assert.equal(new Set(done.events.map(event => event.id)).size, done.events.length);
  assert.equal(done.selection.evaluations.length, 3);
});

test('task failure is repaired before the failed task and dependent tasks retry', async t => {
  let failed = false;
  const f = await fixture(t, { execute(task) { if (!failed) { failed = true; throw new Error('implementation error'); } return { success: true }; } });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.fixAttempts, 1);
  assert.match(f.calls[1], /fix-1$/);
  assert.equal(f.calls[0], f.calls[2]);
  assert.ok(done.events.some(event => event.type === 'task_failed'));
  const project = await f.dependencies.projectRepository.get(done.projectId);
  assert.equal(project.runs.filter(run => run.status === 'failed').length, 1);
});

test('Codex usage counts only started Codex build and repair attempts and survives repository reload', async t => {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: true }),
    execute(task) {
      return task.isFix ? { success: false } : { success: true };
    },
    validate(count) { return { passed: count > 1, checks: [{ name: 'fake', passed: count > 1 }] }; } });
  f.dependencies.executionService.providers.set('codex', { name: 'codex', requiresWorkspace: true, async executeTask(task, context) {
      context.onExecutionStart(context.runId);
      if (task.isFix) context.onExecutionFailure(context.runId);
      return task.isFix ? { success: false } : { success: true };
  } });
  const planner = f.dependencies.projectService.plannerService.providers.get('autonomous');
  const generatePlan = planner.generatePlan.bind(planner);
  planner.generatePlan = async input => {
    const plan = await generatePlan(input);
    plan.phases = plan.phases.slice(0, 1);
    plan.phases[0].tasks[0].dependencies = [];
    return plan;
  };
  f.dependencies.executionProvider = 'codex';
  f.service.executionProvider = 'codex';
  const started = await f.service.start({ requestId: 'usage-metrics' });
  const done = await finish(f.service, started.run.id);
  const reloaded = new (require('../src/repositories/json-autonomous-run-repository').JsonAutonomousRunRepository)(f.dependencies.runRepository.filePath);
  const persisted = await reloaded.get(done.id);
  assert.equal(persisted.codexUsage.codexCallsTotal, 2);
  assert.equal(persisted.codexUsage.buildCalls, 1);
  assert.equal(persisted.codexUsage.repairCalls, 1);
  assert.equal(persisted.codexUsage.failedCalls, 1);
});

test('fake execution provider and deterministic validation do not count as Codex usage', async t => {
  const f = await fixture(t);
  const started = await f.service.start({ requestId: 'no-codex-usage' });
  const done = await finish(f.service, started.run.id);
  assert.deepEqual(done.codexUsage, { codexCallsTotal: 0, buildCalls: 0, repairCalls: 0, failedCalls: 0 });
});

test('Codex metrics deduplicate a process execution ID but count a new attempt for the same task', async t => {
  const f = await fixture(t);
  await f.dependencies.runRepository.create({ id: 'metrics-idempotency-run', state: 'executing', codexUsage: { codexCallsTotal: 0, buildCalls: 0, repairCalls: 0, failedCalls: 0 } });
  await f.service.recordCodexStart('metrics-idempotency-run', 'execution-1', 'build');
  await f.service.recordCodexStart('metrics-idempotency-run', 'execution-1', 'build');
  await f.service.recordCodexFailure('metrics-idempotency-run', 'execution-1');
  await f.service.recordCodexFailure('metrics-idempotency-run', 'execution-1');
  await f.service.recordCodexStart('metrics-idempotency-run', 'execution-2', 'build');
  const run = await f.dependencies.runRepository.get('metrics-idempotency-run');
  assert.deepEqual(run.codexUsage, { codexCallsTotal: 2, buildCalls: 2, repairCalls: 0, failedCalls: 1 });
});

test('Codex budget allows remaining build and repair calls and treats legacy metrics as zero', async t => {
  const f = await fixture(t);
  const cases = [
    ['build-zero', 'build', undefined, true], ['build-two', 'build', { codexCallsTotal: 2, buildCalls: 2, repairCalls: 0, failedCalls: 0 }, true],
    ['repair-zero', 'repair', undefined, true], ['repair-one', 'repair', { codexCallsTotal: 1, buildCalls: 0, repairCalls: 1, failedCalls: 0 }, true]
  ];
  for (const [id, kind, codexUsage, expected] of cases) {
    await f.dependencies.runRepository.create({ id, state: 'executing', projectId: null, events: [], ...(codexUsage ? { codexUsage } : {}) });
    assert.equal(await f.service.checkCodexBudget(id, kind), expected);
  }
});

test('exhausted Codex build budget blocks before execution and marks run Needs Attention', async t => {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: true }) });
  let processAttempts = 0;
  f.dependencies.executionService.providers.set('codex', { name: 'codex', requiresWorkspace: false, async executeTask() { processAttempts++; return { success: true }; } });
  f.service.executionProvider = 'codex';
  const runId = 'build-budget-exhausted', projectId = 'build-budget-project';
  const task = createTask({ id: 'build-budget-task', title: 'Build' });
  await f.dependencies.projectRepository.create({ id: projectId, autonomousRunId: runId, status: 'In progress', runs: [], plan: createPlan({ phases: [createPhase({ name: 'Build', goal: 'Build', tasks: [task] })] }) });
  await f.dependencies.runRepository.create({ id: runId, state: 'executing', projectId, events: [], codexUsage: { codexCallsTotal: 3, buildCalls: 3, repairCalls: 0, failedCalls: 0 } });
  assert.equal(await f.service.execute(runId, await f.dependencies.projectRepository.get(projectId), task), null);
  const blocked = await f.dependencies.runRepository.get(runId);
  assert.equal(processAttempts, 0);
  assert.deepEqual(blocked.codexUsage, { codexCallsTotal: 3, buildCalls: 3, repairCalls: 0, failedCalls: 0 });
  assert.equal(blocked.needsAttention, true);
  assert.equal(blocked.pauseReason, 'Build Codex call budget exhausted');
  assert.equal(blocked.events.at(-1).type, 'codex_budget_exhausted');
  assert.equal((await f.dependencies.projectRepository.get(projectId)).status, 'Needs attention');
});

test('exhausted repair budget pauses before reserving or creating another repair task', async t => {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: true }) });
  let processAttempts = 0;
  f.dependencies.executionService.providers.set('codex', { name: 'codex', requiresWorkspace: false, async executeTask() { processAttempts++; return { success: true }; } });
  f.service.executionProvider = 'codex';
  const runId = 'repair-budget-exhausted', projectId = 'repair-budget-project';
  const task = createTask({ id: 'repair-budget-base', title: 'Build', completed: true });
  await f.dependencies.projectRepository.create({ id: projectId, autonomousRunId: runId, status: 'In progress', runs: [], plan: createPlan({ phases: [createPhase({ name: 'Build', goal: 'Build', tasks: [task] })] }) });
  await f.dependencies.runRepository.create({ id: runId, state: 'fixing', projectId, events: [], pendingFailure: { kind: 'task', taskId: task.id },
    failureAnalysis: { recoverable: true, recommendation: 'Repair it', evidence: 'failed validation' }, fixAttempts: 0, maxFixAttempts: 3,
    codexUsage: { codexCallsTotal: 2, buildCalls: 0, repairCalls: 2, failedCalls: 0 } });
  await f.service.drive(runId);
  const blocked = await f.dependencies.runRepository.get(runId);
  const project = await f.dependencies.projectRepository.get(projectId);
  assert.equal(processAttempts, 0);
  assert.deepEqual(blocked.codexUsage, { codexCallsTotal: 2, buildCalls: 0, repairCalls: 2, failedCalls: 0 });
  assert.equal(blocked.needsAttention, true);
  assert.equal(blocked.pauseReason, 'Repair Codex call budget exhausted');
  assert.equal(blocked.fixAttempts, 0);
  assert.equal(allTasks(project).filter(candidate => candidate.isFix).length, 0);
});

test('Codex infrastructure failure before process start consumes no usage budget', async t => {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: true }) });
  f.dependencies.executionService.providers.set('codex', new CodexExecutionProvider({ spawnProcess() {
    throw Object.assign(new Error('mock process unavailable'), { code: 'ENOENT' });
  } }));
  f.service.executionProvider = 'codex';
  const { run } = await f.service.start({ requestId: 'codex-pre-spawn-failure' });
  const paused = await finish(f.service, run.id);
  assert.equal(paused.needsAttention, true);
  assert.equal(paused.codexUsage.codexCallsTotal, 0);
  assert.equal(paused.codexUsage.buildCalls, 0);
  assert.equal(paused.codexUsage.failedCalls, 0);
});

test('three actual build attempts complete normally and concurrent attempts cannot oversubscribe the remaining budget', async t => {
  const f = await fixture(t, { approvalGate: new ApprovalGate({ allowCodexExecution: true }) });
  let processAttempts = 0;
  f.dependencies.executionService.providers.set('codex', { name: 'codex', requiresWorkspace: false, async executeTask(task, context) {
    processAttempts++;
    await context.onExecutionStart(context.runId);
    return { success: true };
  } });
  f.service.executionProvider = 'codex';
  const { run } = await f.service.start({ requestId: 'three-build-budget' });
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(processAttempts, 3);
  assert.deepEqual(done.codexUsage, { codexCallsTotal: 3, buildCalls: 3, repairCalls: 0, failedCalls: 0 });

  const runId = 'concurrent-budget-run', projectId = 'concurrent-budget-project';
  const tasks = [createTask({ id: 'concurrent-a', title: 'Build A' }), createTask({ id: 'concurrent-b', title: 'Build B' })];
  await f.dependencies.projectRepository.create({ id: projectId, autonomousRunId: runId, status: 'In progress', runs: [], plan: createPlan({ phases: [createPhase({ name: 'Build', goal: 'Build', tasks })] }) });
  await f.dependencies.runRepository.create({ id: runId, state: 'executing', projectId, events: [], codexUsage: { codexCallsTotal: 2, buildCalls: 2, repairCalls: 0, failedCalls: 0 } });
  processAttempts = 0;
  const concurrentProject = await f.dependencies.projectRepository.get(projectId);
  await Promise.all(tasks.map(task => f.service.execute(runId, concurrentProject, task)));
  const concurrent = await f.dependencies.runRepository.get(runId);
  assert.equal(processAttempts, 1);
  assert.equal(concurrent.codexUsage.buildCalls, 3);
});

test('validation failure loops through a fix task and revalidation', async t => {
  const f = await fixture(t, { validate: count => ({ passed: count > 1, checks: [{ name: 'tests', passed: count > 1, error: 'expected 2' }] }) });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.fixAttempts, 1);
  assert.equal(done.validationResults.length, 2);
  assert.ok(done.events.some(event => event.type === 'validation_failed'));
  assert.ok(done.events.find(event => event.type === 'fix_started').failure.validationId);
});

test('MAX_FIX_ATTEMPTS bounds repeated failures and never reports completion', async t => {
  const f = await fixture(t, { maxFixAttempts: 2, validate: () => ({ passed: false, checks: [] }) });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.fixAttempts, 2);
  assert.equal(f.validationCount(), 3);
  assert.equal(done.needsAttention, true);
  assert.match(done.error, /MAX_FIX_ATTEMPTS/);
  assert.equal((await f.dependencies.projectRepository.get(done.projectId)).status, 'Needs attention');
  assert.ok(!done.events.some(event => event.type === 'project_completed'));
});

test('zero fix budget fails immediately, and failed fix execution stops further tasks', async t => {
  const a = await fixture(t, { maxFixAttempts: 0, execute() { throw new Error('broken'); } });
  const { run } = await a.service.start();
  assert.equal((await finish(a.service, run.id)).state, 'failed');
  assert.equal(a.calls.length, 1);
  const b = await fixture(t, { execute() { throw new Error('broken'); } });
  const started = await b.service.start();
  assert.equal((await finish(b.service, started.run.id)).state, 'failed');
  assert.equal(b.calls.length, 2);
});

test('concurrent start is single-flight and request IDs remain idempotent after completion', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.service.start({ requestId: 'same' })));
  assert.equal(new Set(results.map(result => result.run.id)).size, 1);
  await finish(f.service, results[0].run.id);
  assert.equal((await f.service.start({ requestId: 'same' })).duplicate, true);
  assert.equal(f.calls.length, 3);
});

test('pause during execution lets current task settle but prevents new tasks; resume is explicit', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { async execute() { entered.resolve(); await released.promise; return { success: true }; } });
  const { run } = await f.service.start();
  await entered.promise;
  assert.equal((await f.service.pause(run.id)).state, 'paused');
  await assert.rejects(() => f.service.resume(run.id), /must be paused/);
  released.resolve();
  let done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(f.calls.length, 1);
  await f.service.resume(run.id);
  done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(f.calls.length, 3);
});

test('pause during validation preserves result and does not mark completed until resume', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { async validate() { entered.resolve(); await released.promise; return { passed: true }; } });
  const { run } = await f.service.start(); await entered.promise;
  await f.service.pause(run.id); released.resolve();
  assert.equal((await finish(f.service, run.id)).state, 'paused');
  assert.notEqual((await f.dependencies.projectRepository.get((await f.service.runRepository.get(run.id)).projectId)).status, 'Completed');
  await f.service.resume(run.id);
  assert.equal((await finish(f.service, run.id)).state, 'completed');
  assert.equal(f.validationCount(), 1);
});

test('restart recovery pauses interrupted runs without executing anything', async t => {
  const f = await fixture(t);
  await f.dependencies.runRepository.create({ id: 'recovery', state: 'executing', projectId: null, config: {}, events: [] });
  await f.service.initialize();
  const recovered = await f.dependencies.runRepository.get('recovery');
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.resumeState, 'executing');
  assert.equal(recovered.events[0].type, 'run_recovered');
  assert.equal(f.calls.length, 0);
});

test('restart reconciles project creation window rather than creating a duplicate', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  await f.dependencies.runRepository.update(run.id, stored => { stored.state = 'planning'; stored.projectId = null; return true; });
  const restarted = new AutonomousProjectService(f.dependencies);
  await restarted.initialize();
  await restarted.resume(run.id);
  const recovered = await finish(restarted, run.id);
  assert.equal(recovered.projectId, done.projectId);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
  assert.equal(f.calls.length, 3);
});

test('default approval denies credentials, external actions and unknown actions', async t => {
  const gate = new ApprovalGate();
  for (const action of ['git_push', 'production_deployment', 'domain_purchase', 'paid_api', 'secret_write', 'credential_use', 'destructive_filesystem', 'outside_workspace_write', 'codex_execution', 'unknown']) assert.equal(gate.check(action).allowed, false);
  assert.equal(gate.check('workspace_fix').allowed, true);
  assert.equal(new ApprovalGate({ allowCodexExecution: true }).check('codex_execution').allowed, true);
  const f = await fixture(t, { executionProvider: 'codex' });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(f.calls.length, 0);
  assert.ok(done.events.some(event => event.type === 'approval_denied'));
});

test('sandbox infrastructure failure pauses without consuming repair budget', async t => {
  const f = await fixture(t, { validate: () => ({ passed: false, infrastructureError: true }) });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(done.fixAttempts, 0);
  assert.equal(done.pendingFailure, null);
});

test('missing dependencies fail safely without running blocked tasks', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { async execute() { entered.resolve(); await released.promise; return {}; } });
  const { run } = await f.service.start(); await entered.promise;
  const current = await f.dependencies.runRepository.get(run.id);
  await f.dependencies.projectRepository.update(current.projectId, p => { allTasks(p)[1].dependencies = ['missing']; return true; });
  released.resolve();
  assert.equal((await finish(f.service, run.id)).state, 'failed');
  assert.equal(f.calls.length, 1);
});

test('state audit records the successful phase order', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.deepEqual(done.events.filter(event => event.type === 'state_changed').map(event => event.to),
    ['generating_ideas', 'evaluating', 'planning', 'executing', 'testing', 'completed']);
});

test('restart after fix reservation reuses attempt and stable task ID', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start();
  const completed = await finish(f.service, run.id);
  await f.dependencies.runRepository.update(run.id, stored => {
    Object.assign(stored, { state: 'fixing', fixAttempts: 1, activeFixTaskId: `${run.id}-fix-1`,
      validationPassed: false, pendingFailure: { kind: 'validation', message: 'fixture failure' } });
    return true;
  });
  const restarted = new AutonomousProjectService(f.dependencies);
  await restarted.initialize(); await restarted.resume(run.id);
  const done = await finish(restarted, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.fixAttempts, 1);
  assert.equal(f.calls.at(-1), `${run.id}-fix-1`);
  assert.equal(allTasks(await f.dependencies.projectRepository.get(completed.projectId)).filter(task => task.isFix).length, 1);
});

test('restart recovers running task as failed and repairs it before dependency execution', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start(); await finish(f.service, run.id);
  const stored = await f.dependencies.runRepository.get(run.id);
  await f.dependencies.projectRepository.update(stored.projectId, project => {
    allTasks(project).forEach((task, index) => { task.completed = false; task.status = index ? 'pending' : 'running'; });
    const original = project.runs.find(item => item.type === 'task-execution');
    original.status = 'running';
    return true;
  });
  await f.dependencies.runRepository.update(run.id, item => { Object.assign(item, { state: 'executing', validationPassed: false }); return true; });
  const { ExecutionService } = require('../src/services/execution-service');
  const executionService = new ExecutionService({ projectRepository: f.dependencies.projectRepository, workspaceService: f.dependencies.workspaceService,
    providers: [...f.dependencies.executionService.providers.values()] });
  const restarted = new AutonomousProjectService({ ...f.dependencies, executionService });
  await restarted.initialize();
  assert.equal((await f.dependencies.runRepository.get(run.id)).state, 'paused');
  assert.equal(allTasks(await f.dependencies.projectRepository.get(stored.projectId))[0].status, 'failed');
  await restarted.resume(run.id);
  const done = await finish(restarted, run.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.fixAttempts, 1);
  assert.match(f.calls[3], /fix-1$/);
});

test('pause immediately after start does not launch a task', async t => {
  const f = await fixture(t);
  const { run } = await f.service.start();
  await f.service.pause(run.id);
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(f.calls.length, 0);
  assert.equal(f.validationCount(), 0);
});

test('failure analysis identifies actionable validation checks and records repair evidence', async t => {
  const { FailureAnalyzer } = require('../src/services/failure-analyzer');
  const analyzer = new FailureAnalyzer();
  for (const [checkName, category] of [['install', 'package-contract'], ['syntax:src/app.js', 'syntax'], ['tests', 'tests'], ['startup-health', 'startup']]) {
    const analysis = analyzer.analyze({ kind: 'validation', checkName, message: 'failed assertion' });
    assert.equal(analysis.category, category);
    assert.equal(analysis.recoverable, true);
    assert.ok(analysis.recommendation);
  }
  const f = await fixture(t, { validate: count => ({ passed: count > 1, checks: [{ name: 'install', passed: true, output: 'a'.repeat(4000) }, { name: 'tests', passed: count > 1, output: 'the actual assertion failure' }] }) });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  const event = done.events.find(event => event.type === 'failure_analyzed');
  assert.equal(event.category, 'tests');
  assert.match(event.evidence, /actual assertion failure/);
});

test('missing execution infrastructure pauses without a code fix and resumes only explicitly', async t => {
  let first = true;
  const f = await fixture(t, { execute() { if (first) { first = false; throw new Error('Codex CLI is not installed or not available in PATH.'); } return {}; } });
  const { run } = await f.service.start();
  const paused = await finish(f.service, run.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.fixAttempts, 0);
  assert.equal(paused.failureAnalysis.category, 'infrastructure');
  await f.service.resume(run.id);
  assert.equal((await finish(f.service, run.id)).state, 'completed');
});

test('Codex initialization stderr pauses before reserving any repair budget', async t => {
  const f = await fixture(t, { execute: () => {
    const error = new Error('Codex execution failed with exit code 1.');
    error.executionResult = { terminationReason: 'process_exit', stderr: 'failed to initialize in-process app-server client: Read-only file system (os error 30)' };
    throw error;
  } });
  const { run } = await f.service.start();
  const paused = await finish(f.service, run.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.needsAttention, true);
  assert.equal(paused.fixAttempts, 0);
  assert.equal(paused.failureAnalysis.category, 'infrastructure');
  assert.equal(f.calls.length, 1);
  assert.equal(paused.events.some(item => item.type === 'fix_started'), false);
});

test('infrastructure diagnostics distinguish runtime failures from application failures', () => {
  const { FailureAnalyzer } = require('../src/services/failure-analyzer');
  const analyzer = new FailureAnalyzer();
  for (const message of ['Read-only file system', 'Codex initialization failure', 'sandbox initialization failure', 'Unable to start Codex CLI', 'spawn EACCES']) {
    assert.equal(analyzer.analyze({ kind: 'task', message }).category, 'infrastructure', message);
  }
  for (const terminationReason of ['spawn_error', 'process_error', 'stream_error']) {
    assert.equal(analyzer.analyze({ kind: 'task', message: 'failed', output: { terminationReason } }).recoverable, false);
  }
  assert.equal(analyzer.analyze({ kind: 'task', message: 'AssertionError: expected 200 but received 500' }).recoverable, true);
});

test('controlled infrastructure recovery preserves identity, audit and refunds only infrastructure repairs', async t => {
  const f = await fixture(t, { execute: () => { throw new Error('old generic exit code 1'); } });
  const { run } = await f.service.start();
  const failed = await finish(f.service, run.id);
  assert.equal(failed.state, 'failed');
  await assert.rejects(() => f.service.retryInfrastructureFailure(run.id), /infrastructure evidence/);
  await f.dependencies.projectRepository.update(failed.projectId, project => {
    for (const task of project.plan.phases.flatMap(p => p.tasks).filter(t => t.status === 'failed')) {
      task.result = { stderr: 'failed to initialize in-process app-server client: Read-only file system' };
    }
    return true;
  });
  const originalUpdate = f.dependencies.runRepository.update.bind(f.dependencies.runRepository);
  let rejectOnce = true;
  f.dependencies.runRepository.update = async (...args) => {
    if (rejectOnce) { rejectOnce = false; throw new Error('Simulated recovery checkpoint outage'); }
    return originalUpdate(...args);
  };
  await assert.rejects(() => f.service.retryInfrastructureFailure(run.id), /checkpoint outage/);
  const recovered = await f.service.retryInfrastructureFailure(run.id);
  assert.equal(recovered.id, run.id);
  assert.equal(recovered.projectId, failed.projectId);
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.fixAttempts, 0);
  const project = await f.dependencies.projectRepository.get(failed.projectId);
  assert.equal(project.archivedInfrastructureTasks.length, 1);
  assert.equal(project.plan.phases.flatMap(p => p.tasks).filter(t => t.status === 'pending').length, 3);
  assert.equal(project.runs.filter(r => r.status === 'failed').length, 2);
  await assert.rejects(() => f.service.retryInfrastructureFailure(run.id), /idle failed run/);
});

test('infrastructure failure during a repair refunds the reservation and explicit resume retries the same repair', async t => {
  let infrastructure = true;
  let first = true;
  const f = await fixture(t, { execute: task => {
    if (first) { first = false; throw new Error('Application assertion failed'); }
    if (task.isFix && infrastructure) {
      const error = new Error('Codex exit 1');
      error.executionResult = { stderr: 'Read-only file system' };
      throw error;
    }
    return { success: true };
  } });
  const { run } = await f.service.start();
  const paused = await finish(f.service, run.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.fixAttempts, 0);
  const fixId = paused.activeFixTaskId;
  infrastructure = false;
  await f.service.resume(run.id);
  const completed = await finish(f.service, run.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.fixAttempts, 1);
  assert.equal(f.calls.filter(id => id === fixId).length, 2);
});

test('legacy validator configuration failure refunds its repair and resumes validation on the same project', async t => {
  let broken = true;
  const f = await fixture(t, { execute: task => { if (task.isFix) throw new Error('Interrupted by restart'); return { success: true }; }, validate: () => broken ? { passed: false, checks: [{ name: 'install', passed: false, output: 'double-loading config' }] } : { passed: true } });
  const analyze = f.service.failureAnalyzer.analyze.bind(f.service.failureAnalyzer);
  f.service.failureAnalyzer.analyze = () => ({ recoverable: true, category: 'package-contract', recommendation: 'legacy', evidence: 'legacy' });
  const { run } = await f.service.start();
  const failed = await finish(f.service, run.id);
  assert.equal(failed.state, 'failed');
  f.service.failureAnalyzer.analyze = analyze;
  await f.dependencies.runRepository.update(run.id, stored => {
    stored.events.unshift({ type: 'fix_started', taskId: stored.activeFixTaskId, failure: { kind: 'task', taskId: 'obsolete-infrastructure-task' } });
    return true;
  });
  const recovered = await f.service.retryInfrastructureFailure(run.id);
  assert.equal(recovered.resumeState, 'testing');
  assert.equal(recovered.fixAttempts, 0);
  broken = false;
  await f.service.resume(run.id);
  assert.equal((await finish(f.service, run.id)).state, 'completed');
  assert.equal(f.calls.length, 4);
});

test('Git metadata and structured validator failures pause without application repairs', async t => {
  for (const check of [
    { name: 'contract', passed: false, error: 'Git metadata requires operator review: ".git"' },
    { name: 'contract', passed: false, infrastructureError: true, error: 'factory configuration failed' }
  ]) {
    const f = await fixture(t, { validate: () => ({ passed: false, checks: [check] }) });
    const { run } = await f.service.start();
    const paused = await finish(f.service, run.id);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.fixAttempts, 0);
    assert.equal(paused.failureAnalysis.category, 'infrastructure');
    assert.equal(paused.events.some(item => item.type === 'fix_started'), false);
    const project = await f.dependencies.projectRepository.get(paused.projectId);
    assert.equal(project.status, 'Needs attention');
    assert.equal(allTasks(project).some(task => task.isFix), false);
  }
});

test('legacy Git recovery refunds only validation repairs and is restart-idempotent', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  let failTask = true;
  let valid = false;
  const f = await fixture(t, {
    execute() { if (failTask) { failTask = false; throw new Error('Codex execution timed out after 600000ms.'); } return { success: true }; },
    validate: () => valid ? { passed: true, checks: [{ name: 'tests', passed: true, output: '# pass 25' }] } :
      { passed: false, checks: [{ name: 'contract', passed: false, error: 'Sensitive or configuration files are not allowed in validation workspace.' }] }
  });
  const { run } = await f.service.start();
  const failed = await finish(f.service, run.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fixAttempts, 3);
  const workspace = await f.dependencies.workspaceService.getWorkspacePath(failed.projectId);
  await fs.mkdir(path.join(workspace, '.git'));
  await assert.rejects(() => f.service.recoverValidationInfrastructureFailure(run.id), /revalidation did not pass/);
  assert.deepEqual(await f.dependencies.runRepository.get(run.id), failed);
  valid = true;
  const update = f.dependencies.projectRepository.update.bind(f.dependencies.projectRepository);
  let interrupted = true;
  f.dependencies.projectRepository.update = async (...args) => {
    if (interrupted) { interrupted = false; throw new Error('project checkpoint interrupted'); }
    return update(...args);
  };
  await assert.rejects(() => f.service.recoverValidationInfrastructureFailure(run.id), /checkpoint interrupted/);
  const recovered = await f.service.recoverValidationInfrastructureFailure(run.id);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.fixAttempts, 1);
  assert.deepEqual(recovered.validationInfrastructureRecovery.taskIds, [`${run.id}-fix-2`, `${run.id}-fix-3`]);
  assert.equal(recovered.projectId, failed.projectId);
  assert.equal(recovered.validationResults.length, failed.validationResults.length + 1);
  assert.deepEqual(recovered.events.slice(0, failed.events.length), failed.events);
  const project = await f.dependencies.projectRepository.get(failed.projectId);
  assert.equal(project.status, 'Completed');
  assert.equal(allTasks(project).filter(task => task.isFix).length, 3);
  assert.equal((await f.dependencies.runRepository.list()).length, 1);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
});

test('validation recovery rejects application failures and populated Git metadata', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const f = await fixture(t, { validate: () => ({ passed: false, checks: [{ name: 'tests', passed: false, error: 'assertion failed' }] }) });
  const { run } = await f.service.start();
  const failed = await finish(f.service, run.id);
  await assert.rejects(() => f.service.recoverValidationInfrastructureFailure(run.id), /legacy Git contract evidence/);
  assert.equal((await f.dependencies.runRepository.get(run.id)).fixAttempts, 3);
  const g = await fixture(t, { validate: () => ({ passed: false, checks: [{ name: 'contract', passed: false, error: 'Sensitive or configuration files are not allowed in validation workspace.' }] }) });
  const started = await g.service.start();
  const legacy = await finish(g.service, started.run.id);
  const workspace = await g.dependencies.workspaceService.getWorkspacePath(legacy.projectId);
  await fs.mkdir(path.join(workspace, '.git'));
  await fs.writeFile(path.join(workspace, '.git/config'), 'fixture');
  await assert.rejects(() => g.service.recoverValidationInfrastructureFailure(started.run.id), /empty root Git/);
  assert.equal((await g.dependencies.runRepository.get(started.run.id)).fixAttempts, 3);
});
