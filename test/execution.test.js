const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createTask, createPhase, createPlan } = require('../src/domain');
const { TemplateExecutionProvider } = require('../src/providers/template-execution-provider');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { ExecutionService } = require('../src/services/execution-service');

async function temporaryRepository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-execution-test-'));
  return { directory, repository: new JsonProjectRepository(path.join(directory, 'projects.json')) };
}

function projectWithTasks(tasks) {
  return {
    id: 'project-execution',
    name: 'Execution project',
    status: 'Planning',
    plan: createPlan({ id: 'plan-execution', phases: [createPhase({ name: 'Build', goal: 'Build it', tasks })] }),
    runs: []
  };
}

test('ExecutionService completes a pending task, persists its result, and completes its run', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ id: 'task-ready', title: 'Implement feature', estimate: '1 hour' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, providers: [new TemplateExecutionProvider()] });

  const result = await service.executeTask(project, task, { provider: 'template' });
  const stored = await repository.get(project.id);

  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.completed, true);
  assert.deepEqual(result.task.result.events, ['task received', 'execution started', 'execution completed']);
  assert.equal(result.run.status, 'completed');
  assert.equal(stored.runs.length, 1);
  assert.equal(stored.runs[0].status, 'completed');
  assert.deepEqual(stored.plan.phases[0].tasks[0].result, result.task.result);
});

test('ExecutionService blocks incomplete dependencies without invoking its provider or creating a run', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const prerequisite = createTask({ id: 'task-prerequisite', title: 'Prepare API', estimate: '1 hour' });
  const task = createTask({ id: 'task-dependent', title: 'Use API', estimate: '1 hour', dependencies: [prerequisite.id] });
  const project = projectWithTasks([prerequisite, task]);
  await repository.create(project);
  let called = false;
  const provider = { name: 'fixture', async executeTask() { called = true; } };
  const service = new ExecutionService({ projectRepository: repository, providers: [provider] });

  const result = await service.executeTask(project, task, { provider: 'fixture' });
  const stored = await repository.get(project.id);

  assert.equal(result.blocked, true);
  assert.equal(result.task.status, 'blocked');
  assert.match(result.error, /Prepare API/);
  assert.equal(called, false);
  assert.equal(stored.runs.length, 0);
});

test('ExecutionService records provider errors on the task and run', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ id: 'task-failing', title: 'Fail safely', estimate: '1 hour' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  const provider = { name: 'failing', async executeTask() { throw new Error('Provider did not finish.'); } };
  const service = new ExecutionService({ projectRepository: repository, providers: [provider] });

  const result = await service.executeTask(project, task, { provider: 'failing' });
  const stored = await repository.get(project.id);

  assert.equal(result.failed, true);
  assert.equal(result.task.status, 'failed');
  assert.equal(result.task.error, 'Provider did not finish.');
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.error.message, 'Provider did not finish.');
  assert.equal(stored.runs[0].status, 'failed');
});

test('task execution and run listing endpoints return persisted execution data', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ id: 'task-api', title: 'Run through API', estimate: '1 hour' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, providers: [new TemplateExecutionProvider()] });
  const server = createApp({ projectRepository: repository, executionService: service }).listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const execution = await fetch(`${baseUrl}/api/projects/${project.id}/tasks/${task.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'template' }) });
  assert.equal(execution.status, 202);
  const body = await execution.json();
  assert.equal(body.task.status, 'running');
  assert.equal(body.run.status, 'running');
  await Promise.all([...service.jobs.values()]);
  const runs = await fetch(`${baseUrl}/api/projects/${project.id}/runs`);
  assert.equal(runs.status, 200);
  const listed = await runs.json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, body.run.id);
});

test('task execution endpoint returns 409 for a blocked task', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = createTask({ id: 'task-first', title: 'First', estimate: '1 hour' });
  const second = createTask({ id: 'task-second', title: 'Second', estimate: '1 hour', dependencies: [first.id] });
  const project = projectWithTasks([first, second]);
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, providers: [new TemplateExecutionProvider()] });
  const server = createApp({ projectRepository: repository, executionService: service }).listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project.id}/tasks/${second.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).task.status, 'blocked');
});

for (const scenario of ['rejection', 'exception', 'workspace', 'timeout']) {
  test(`background ${scenario} stores a terminal error on both task and run`, async t => {
    const { directory, repository } = await temporaryRepository();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const task = createTask({ title: 'Failure fixture' });
    const project = projectWithTasks([task]);
    await repository.create(project);
    const provider = { name: 'fixture', requiresWorkspace: scenario === 'workspace', executeTask() {
      if (scenario === 'exception') throw new Error('Unexpected exception');
      if (scenario === 'timeout') return new Promise(() => {});
      return Promise.reject(new Error('Rejected execution'));
    } };
    const service = new ExecutionService({ projectRepository: repository, providers: [provider], jobTimeoutMs: 20 });
    const accepted = await service.startTask(project, task, { provider: 'fixture' });
    assert.equal(accepted.run.status, 'running');
    await service.jobs.get(accepted.run.id);
    const stored = await repository.get(project.id);
    assert.equal(stored.runs[0].status, 'failed');
    assert.equal(stored.plan.phases[0].tasks[0].status, 'failed');
    assert.equal(stored.runs[0].error.message, stored.plan.phases[0].tasks[0].error);
    assert.ok(stored.runs[0].completedAt);
    assert.equal(service.jobs.size, 0);
  });
}

test('HTTP response finishes while provider is pending, duplicates are rejected, and GET tracks completion', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ title: 'Deferred execution' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  let finish;
  let calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const service = new ExecutionService({ projectRepository: repository, providers: [{ name: 'fixture', executeTask() { calls++; return pending; } }] });
  const server = createApp({ projectRepository: repository, executionService: service }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  t.after(async () => { finish({ message: 'done' }); await Promise.all([...service.jobs.values()]); });
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${project.id}`;
  const start = () => fetch(`${base}/tasks/${task.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'fixture', workspacePath: '/untrusted' }), signal: AbortSignal.timeout(2000) });
  const responses = await Promise.all([start(), start()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const accepted = await responses.find(response => response.status === 202).json();
  assert.equal(accepted.task.status, 'running');
  assert.equal((await (await fetch(`${base}/runs`)).json())[0].status, 'running');
  assert.equal(calls, 1);
  const job = service.jobs.get(accepted.run.id);
  finish({ message: 'done' });
  await job;
  const runs = await (await fetch(`${base}/runs`)).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].output.message, 'done');
});

test('restart recovery fails interrupted runs and tasks without executing providers', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ title: 'Interrupted', status: 'running' });
  const project = projectWithTasks([task]);
  project.runs = [{ id: 'interrupted', taskId: task.id, type: 'task-execution', status: 'running' }];
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, providers: [] });
  await service.initialize();
  const stored = await repository.get(project.id);
  assert.equal(stored.runs[0].status, 'failed');
  assert.equal(stored.plan.phases[0].tasks[0].status, 'failed');
  assert.match(stored.runs[0].error.message, /restart/);
});

test('concurrent distinct task jobs retain both terminal runs and transient write failures are retried', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tasks = [createTask({ title: 'One' }), createTask({ title: 'Two' })];
  const project = projectWithTasks(tasks);
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, providers: [new TemplateExecutionProvider()] });
  await service.initialize();
  const original = repository.write.bind(repository);
  let failures = 0;
  repository.write = async projects => {
    if (projects[0].runs.some(run => run.status === 'completed') && failures++ === 0) throw new Error('Transient disk error');
    return original(projects);
  };
  await Promise.all(tasks.map(task => service.executeTask(project, task)));
  const stored = await repository.get(project.id);
  assert.equal(stored.runs.length, 2);
  assert.ok(stored.runs.every(run => run.status === 'completed'));
  assert.ok(stored.plan.phases[0].tasks.every(task => task.completed));
});

test('late provider rejection cannot overwrite a timeout and is handled', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ title: 'Late rejection' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const service = new ExecutionService({ projectRepository: repository, jobTimeoutMs: 10, providers: [{ name: 'fixture', executeTask: () => pending }] });
  const result = await service.executeTask(project, task, { provider: 'fixture' });
  assert.match(result.error, /timed out/);
  reject(new Error('Late failure'));
  await new Promise(resolve => setImmediate(resolve));
  const stored = await repository.get(project.id);
  assert.equal(stored.runs[0].status, 'failed');
  assert.match(stored.runs[0].error.message, /timed out/);
});

test('workspace resolution after the deadline does not launch a provider', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = createTask({ title: 'Late workspace' });
  const project = projectWithTasks([task]);
  await repository.create(project);
  let resolveWorkspace;
  let called = false;
  const service = new ExecutionService({ projectRepository: repository, jobTimeoutMs: 10,
    workspaceService: { getWorkspacePath: () => new Promise(resolve => { resolveWorkspace = resolve; }) },
    providers: [{ name: 'fixture', requiresWorkspace: true, executeTask() { called = true; } }]
  });
  const result = await service.executeTask(project, task, { provider: 'fixture' });
  assert.equal(result.run.status, 'failed');
  resolveWorkspace(directory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
});
