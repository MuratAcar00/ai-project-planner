const fs = require('node:fs/promises');
const path = require('node:path');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { JsonAutonomousRunRepository } = require('../src/repositories/json-autonomous-run-repository');
const { WorkspaceService } = require('../src/services/workspace-service');
const { ExecutionService } = require('../src/services/execution-service');
const { ProjectService } = require('../src/services/project-service');
const { PlannerService } = require('../src/services/planner-service');
const { AutonomousPlannerProvider } = require('../src/providers/autonomous-planner-provider');
const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
const { IdeaEvaluator } = require('../src/services/idea-evaluator');
const { ApprovalGate } = require('../src/services/approval-gate');
const { AutonomousProjectService } = require('../src/services/autonomous-project-service');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const root = path.resolve('.test-tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'autonomous-'));
  const projectRepository = new JsonProjectRepository(path.join(directory, 'projects.json'));
  const runRepository = new JsonAutonomousRunRepository(path.join(directory, 'runs.json'));
  const workspaceService = new WorkspaceService({ workspaceRoot: path.join(directory, 'workspaces') });
  const calls = [];
  const provider = { name: 'fake', requiresWorkspace: true, async executeTask(task, context) {
    calls.push(task.id);
    return options.execute ? options.execute(task, context) : { success: true };
  } };
  const executionService = new ExecutionService({ projectRepository, workspaceService, providers: [provider] });
  const projectService = new ProjectService({ projectRepository, plannerService: new PlannerService({ providers: [new AutonomousPlannerProvider()] }) });
  let validations = 0;
  const dependencies = { runRepository, projectRepository, projectService, executionService, workspaceService,
    ideaProvider: options.ideaProvider || new TemplateIdeaProvider(), ideaEvaluator: new IdeaEvaluator(),
    approvalGate: options.approvalGate || new ApprovalGate(), executionProvider: options.executionProvider || 'fake', maxFixAttempts: options.maxFixAttempts ?? 3, maxIdeaBatches: options.maxIdeaBatches ?? 4,
    flutterScaffolder: options.flutterScaffolder,
    validationService: { async validate(context) { validations++; return options.validate ? options.validate(validations, context) : { passed: true, checks: [] }; } } };
  const service = new AutonomousProjectService(dependencies);
  t.after(async () => { await Promise.all([...service.jobs.values()]); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, dependencies, calls, directory, validationCount: () => validations };
}
async function finish(service, id) { await service.jobs.get(id); return service.runRepository.get(id); }
module.exports = { fixture, finish, deferred };
