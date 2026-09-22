const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, finish, deferred } = require('./autonomous-helpers');
const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
const { IdeaEvaluator } = require('../src/services/idea-evaluator');
const { ApprovalGate } = require('../src/services/approval-gate');
const { AutonomousProjectService, validateStart, fixLimit } = require('../src/services/autonomous-project-service');
const { transition } = require('../src/autonomous/state');
const { allTasks } = require('../src/services/execution-service');

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
  assert.equal(f.calls.length, 4);
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
  assert.equal(f.calls.length, 4);
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
  assert.equal(f.calls.length, 4);
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
  assert.match(f.calls[4], /fix-1$/);
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
  assert.equal(project.plan.phases.flatMap(p => p.tasks).filter(t => t.status === 'pending').length, 4);
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
  assert.equal(f.calls.length, 5);
});
