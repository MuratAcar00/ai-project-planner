const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TemplatePlannerProvider } = require('../src/providers/template-planner-provider');
const { PlannerService } = require('../src/services/planner-service');
const { ProjectService } = require('../src/services/project-service');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { createTask, createPhase, createPlan, createRun, startRun, completeRun } = require('../src/domain');

const input = {
  name: 'Focus Flow',
  description: 'A web app that helps remote workers focus using timed sessions.',
  platform: 'Web',
  technology: 'JavaScript',
  experienceLevel: 'Intermediate'
};

async function temporaryRepository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-architecture-test-'));
  return {
    directory,
    repository: new JsonProjectRepository(path.join(directory, 'projects.json'))
  };
}

test('TemplatePlannerProvider preserves the deterministic phase and task structure', async () => {
  const provider = new TemplatePlannerProvider();
  const plan = await provider.generatePlan(input);

  assert.equal(provider.name, 'template');
  assert.equal(plan.phases.length, 4);
  assert.equal(plan.phases.flatMap(phase => phase.tasks).length, 12);
  assert.equal(plan.phases[0].tasks[0].completed, false);
});

test('PlannerService delegates asynchronously to the selected provider', async () => {
  const provider = {
    name: 'fixture',
    async generatePlan(projectInput) {
      return { phases: [], overview: projectInput.name };
    }
  };
  const service = new PlannerService({ providers: [provider] });
  const generated = await service.generatePlan(input, { provider: 'fixture' });

  assert.equal(generated.provider, 'fixture');
  assert.equal(generated.plan.overview, input.name);
  await assert.rejects(() => service.generatePlan(input), /Unknown planner provider/);
});

test('JsonProjectRepository persists project CRUD through the repository contract', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = { id: 'project-repository', plan: { phases: [] } };

  await repository.create(project);
  assert.deepEqual(await repository.get(project.id), project);
  assert.equal((await repository.list()).length, 1);
  const updated = await repository.update(project.id, stored => { stored.status = 'In progress'; return true; });
  assert.equal(updated.status, 'In progress');
  assert.equal(await repository.delete(project.id), true);
  assert.equal(await repository.get(project.id), null);
});

test('ProjectService creates requirements, a provider-backed plan, and a completed planning run', async t => {
  const { directory, repository } = await temporaryRepository();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plannerService = new PlannerService({ providers: [new TemplatePlannerProvider()] });
  const service = new ProjectService({ projectRepository: repository, plannerService });

  const project = await service.createProject(input);

  assert.equal(project.requirements.problemStatement, input.description);
  assert.deepEqual(project.requirements.items, []);
  assert.equal(project.plan.provider, 'template');
  assert.equal(project.plan.phases.length, 4);
  assert.equal(project.runs.length, 1);
  assert.deepEqual(project.runs[0].projectId, project.id);
  assert.equal(project.runs[0].type, 'plan-generation');
  assert.equal(project.runs[0].status, 'completed');
  assert.equal(project.runs[0].output.provider, 'template');
  assert.equal((await repository.get(project.id)).id, project.id);
});

test('Run model records its lifecycle and output', () => {
  const pending = createRun({ projectId: 'project-run', type: 'test' });
  const running = startRun(pending);
  const completed = completeRun(running, { passed: true });

  assert.equal(pending.status, 'pending');
  assert.equal(running.status, 'running');
  assert.ok(running.startedAt);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.deepEqual(completed.output, { passed: true });
});

test('Plan, Phase, and Task factories retain the original plan nesting', () => {
  const task = createTask({ id: 'task-domain', title: 'Build feature', estimate: '1 hour' });
  const phase = createPhase({ name: 'Build', goal: 'Deliver value', tasks: [task] });
  const plan = createPlan({ id: 'plan-domain', phases: [phase] });

  assert.equal(plan.phases[0].name, 'Build');
  assert.deepEqual(plan.phases[0].tasks[0], task);
});
