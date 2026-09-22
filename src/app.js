const express = require('express');
const { GeneratedAppRuntimeService } = require('./services/generated-app-runtime-service');
const { runSummary, eventSummary } = require('./autonomous/presentation');
const path = require('node:path');
const { JsonProjectRepository } = require('./repositories/json-project-repository');
const { validateProjectInput, validateTaskUpdate } = require('./validation');
const { TemplatePlannerProvider } = require('./providers/template-planner-provider');
const { TemplateExecutionProvider } = require('./providers/template-execution-provider');
const { CodexExecutionProvider } = require('./providers/codex-execution-provider');
const { PlannerService } = require('./services/planner-service');
const { ProjectService } = require('./services/project-service');
const { ExecutionService, allTasks, updateProjectStatus } = require('./services/execution-service');
const { WorkspaceService } = require('./services/workspace-service');
const { AutonomousPlannerProvider } = require('./providers/autonomous-planner-provider');
const { LocalIdeaProvider } = require('./providers/local-idea-provider');
const { IdeaEvaluator } = require('./services/idea-evaluator');
const { ApprovalGate } = require('./services/approval-gate');
const { WorkspaceValidationService } = require('./services/workspace-validation-service');
const { AutonomousProjectService, validateStart } = require('./services/autonomous-project-service');
const { JsonAutonomousRunRepository } = require('./repositories/json-autonomous-run-repository');

const summary = project => {
  const tasks = project.plan.phases.flatMap(phase => phase.tasks);
  const completedTasks = tasks.filter(task => task.completed).length;
  if (project.autonomousRunId) return { id: project.id, name: project.name, autonomousRunId: project.autonomousRunId, status: project.status, createdAt: project.createdAt, completedTasks, remainingTasks: tasks.length - completedTasks, progress: tasks.length ? Math.round(completedTasks / tasks.length * 100) : 0 };
  return { ...project, completedTasks, remainingTasks: tasks.length - completedTasks, progress: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0 };
};

function createApp({ dataFile, projectRepository, plannerService, executionService, workspaceService, autonomousService, autonomousRunRepository, approvalGate, runtimeService } = {}) {
  const app = express();
  const repository = projectRepository || new JsonProjectRepository(dataFile || path.join(__dirname, '..', 'data', 'projects.json'));
  const planning = plannerService || new PlannerService({ providers: [new TemplatePlannerProvider(), new AutonomousPlannerProvider()] });
  const projectService = new ProjectService({ projectRepository: repository, plannerService: planning });
  const workspaces = workspaceService || new WorkspaceService();
  const execution = executionService || new ExecutionService({ projectRepository: repository, workspaceService: workspaces, providers: [new TemplateExecutionProvider(), new CodexExecutionProvider({ isolatedRuntimeRoot: path.join(__dirname, '..', '.cache', 'codex-runtime') })] });
  const autonomous = autonomousService || new AutonomousProjectService({
    runRepository: autonomousRunRepository || new JsonAutonomousRunRepository(path.join(path.dirname(dataFile || repository.filePath || path.join(__dirname, '..', 'data', 'projects.json')), 'autonomous-runs.json')),
    projectRepository: repository, projectService, executionService: execution, workspaceService: workspaces,
    ideaProvider: new LocalIdeaProvider(), ideaEvaluator: new IdeaEvaluator(),
    validationService: new WorkspaceValidationService({ workspaceService: workspaces }), approvalGate: approvalGate || new ApprovalGate()
  });
  const runtime = runtimeService || new GeneratedAppRuntimeService({ projectRepository: repository, runRepository: autonomous.runRepository, workspaceService: workspaces });
  app.locals.runtime = runtime;
  const present = async run => runSummary(run, run.projectId ? await repository.get(run.projectId) : null);
  const ready = Promise.all([execution.initialize(), autonomous.initialize()]);
  app.use((req, res, next) => { ready.then(() => next(), next); });
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use(['/api/autonomous', '/api/projects/:id/runtime'], (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    if (req.get('origin')) {
      try { if (new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin control is disabled.' }); }
      catch { return res.status(403).json({ error: 'Invalid origin.' }); }
    }
    next();
  });
  // No command, provider, path, approval or environment input is accepted here.
  app.post('/api/autonomous/start', async (req, res, next) => {
    try {
      try { validateStart(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
      const result = await autonomous.start(req.body);
      res.status(202).json({ ...result, run: await present(result.run) });
    } catch (error) { next(error); }
  });
  app.get('/api/autonomous', async (req, res, next) => {
    try { res.json(await Promise.all((await autonomous.runRepository.list()).map(present))); } catch (error) { next(error); }
  });
  app.get('/api/autonomous/:id', async (req, res, next) => {
    try {
      const run = await autonomous.runRepository.get(req.params.id);
      if (!run) return res.status(404).json({ error: 'Autonomous run not found.' });
      res.json(await present(run));
    } catch (error) { next(error); }
  });
  app.get('/api/autonomous/:id/events', async (req, res, next) => {
    try {
      const run = await autonomous.runRepository.get(req.params.id);
      if (!run) return res.status(404).json({ error: 'Autonomous run not found.' });
      const project = run.projectId ? await repository.get(run.projectId) : null;
      res.json(run.events.map(event => eventSummary(event, run, project)));
    } catch (error) { next(error); }
  });
  for (const action of ['pause', 'resume']) app.post(`/api/autonomous/:id/${action}`, async (req, res, next) => {
    try {
      if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) return res.status(400).json({ error: 'This action takes no configuration.' });
      const current = await autonomous.runRepository.get(req.params.id);
      if (action === 'resume' && current?.needsAttention) return res.status(409).json({ error: 'Needs Attention: trusted operator review is required.' });
      const run = await autonomous[action](req.params.id);
      if (!run) return res.status(404).json({ error: 'Autonomous run not found.' });
      res.status(202).json(await present(run));
    } catch (error) {
      if (error.message.startsWith('Run must be paused')) return res.status(409).json({ error: error.message });
      next(error);
    }
  });
  app.use('/api/projects/:id/runtime', (req, res, next) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    let hostname;
    try { hostname = new URL(`http://${req.get('host')}`).hostname; } catch { /* Reject invalid Host. */ }
    if (!local || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return res.status(403).json({ error: 'Runtime controls are localhost only.' });
    next();
  });
  for (const action of ['start', 'stop', 'status']) {
    app[action === 'status' ? 'get' : 'post'](`/api/projects/:id/runtime${action === 'status' ? '' : '/' + action}`, async (req, res, next) => {
      try {
        if (Object.keys(req.query).length || (action !== 'status' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) return res.status(400).json({ error: 'Runtime accepts only a project ID and an empty JSON object.' });
        res.json(await runtime[action](req.params.id));
      } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
    });
  }
  app.get('/api/projects', async (req, res, next) => { try { res.json((await repository.list()).map(summary)); } catch (e) { next(e); } });
  app.post('/api/projects', async (req, res, next) => {
    try { const result = validateProjectInput(req.body); if (!result.valid) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: result.errors });
      res.status(201).json(summary(await projectService.createProject(result.project)));
    } catch (e) { next(e); }
  });
  app.get('/api/projects/:id', async (req, res, next) => { try { const project = await repository.get(req.params.id); if (!project) return res.status(404).json({ error: 'Project not found.' }); res.json(summary(project)); } catch (e) { next(e); } });
  app.patch('/api/projects/:id/tasks/:taskId', async (req, res, next) => {
    try {
      if ((await repository.get(req.params.id))?.autonomousRunId) return res.status(409).json({ error: 'Autonomous tasks are managed by the orchestrator.' });
      const validation = validateTaskUpdate(req.body);
      if (!validation.valid) return res.status(400).json({ error: 'Please correct the task fields.', fields: validation.errors });
      if (validation.update.dependencies) {
        const currentProject = await repository.get(req.params.id);
        if (!currentProject) return res.status(404).json({ error: 'Project not found.' });
        const taskIds = new Set(allTasks(currentProject).map(candidate => candidate.id));
        if (validation.update.dependencies.includes(req.params.taskId) || validation.update.dependencies.some(id => !taskIds.has(id))) return res.status(400).json({ error: 'dependencies must reference other tasks in this project.' });
      }
      const updated = await repository.update(req.params.id, project => {
        const task = allTasks(project).find(candidate => candidate.id === req.params.taskId);
        if (!task) return false;
        Object.assign(task, validation.update);
        if (validation.update.completed !== undefined) task.status = validation.update.completed ? 'completed' : 'pending';
        if (validation.update.status !== undefined) task.completed = validation.update.status === 'completed';
        if (task.completed) task.completedAt = task.completedAt || new Date().toISOString();
        updateProjectStatus(project);
        return true;
      });
      if (updated === null) return res.status(404).json({ error: 'Project not found.' });
      if (updated === false) return res.status(404).json({ error: 'Task not found.' }); res.json(summary(updated));
    } catch (e) { next(e); }
  });
  app.post('/api/projects/:id/tasks/:taskId/run', async (req, res, next) => {
    try {
      const project = await repository.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found.' });
      if (project.autonomousRunId) return res.status(409).json({ error: 'Autonomous tasks are managed by the orchestrator.' });
      const task = allTasks(project).find(candidate => candidate.id === req.params.taskId);
      if (!task) return res.status(404).json({ error: 'Task not found.' });
      const provider = req.body && req.body.provider;
      if (provider !== undefined && (typeof provider !== 'string' || !provider.trim() || provider.length > 50)) return res.status(400).json({ error: 'provider must be a non-empty string up to 50 characters.' });
      const result = await execution.startTask(project, task, { provider: provider || 'template' });
      if (result.blocked || result.duplicate) return res.status(409).json(result);
      res.status(202).json(result);
    } catch (e) {
      if (e.message === 'Project not found.' || e.message === 'Task not found.') return res.status(404).json({ error: e.message });
      if (e.message.startsWith('Unknown execution provider:')) return res.status(400).json({ error: e.message });
      next(e);
    }
  });
  app.get('/api/projects/:id/runs', async (req, res, next) => {
    try {
      const project = await repository.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found.' });
      res.json(project.autonomousRunId ? (project.runs || []).map(run => ({ id: run.id, status: run.status, createdAt: run.createdAt })) : project.runs || []);
    } catch (e) { next(e); }
  });
  app.delete('/api/projects/:id', async (req, res, next) => { try { if ((await repository.get(req.params.id))?.autonomousRunId) return res.status(409).json({ error: 'Autonomous project deletion is disabled.' }); if (!await repository.delete(req.params.id)) return res.status(404).json({ error: 'Project not found.' }); res.status(204).end(); } catch (e) { next(e); } });
  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    console.error('Request failed.'); res.status(500).json({ error: 'An unexpected server error occurred.' });
  });
  return app;
}
module.exports = { createApp };
