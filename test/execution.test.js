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
  const server = createApp({ projectRepository: repository }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const execution = await fetch(`${baseUrl}/api/projects/${project.id}/tasks/${task.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'template' }) });
  assert.equal(execution.status, 201);
  const body = await execution.json();
  assert.equal(body.task.status, 'completed');
  assert.equal(body.run.status, 'completed');
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
  const server = createApp({ projectRepository: repository }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project.id}/tasks/${second.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).task.status, 'blocked');
});
