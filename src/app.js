const express = require('express');
const path = require('node:path');
const { JsonProjectRepository } = require('./repositories/json-project-repository');
const { validateProjectInput, validateTaskUpdate } = require('./validation');
const { TemplatePlannerProvider } = require('./providers/template-planner-provider');
const { TemplateExecutionProvider } = require('./providers/template-execution-provider');
const { PlannerService } = require('./services/planner-service');
const { ProjectService } = require('./services/project-service');
const { ExecutionService, allTasks, updateProjectStatus } = require('./services/execution-service');

const summary = project => {
  const tasks = project.plan.phases.flatMap(phase => phase.tasks);
  const completedTasks = tasks.filter(task => task.completed).length;
  return { ...project, completedTasks, remainingTasks: tasks.length - completedTasks, progress: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0 };
};

function createApp({ dataFile, projectRepository, plannerService, executionService } = {}) {
  const app = express();
  const repository = projectRepository || new JsonProjectRepository(dataFile || path.join(__dirname, '..', 'data', 'projects.json'));
  const planning = plannerService || new PlannerService({ providers: [new TemplatePlannerProvider()] });
  const projectService = new ProjectService({ projectRepository: repository, plannerService: planning });
  const execution = executionService || new ExecutionService({ projectRepository: repository, providers: [new TemplateExecutionProvider()] });
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/projects', async (req, res, next) => { try { res.json((await repository.list()).map(summary)); } catch (e) { next(e); } });
  app.post('/api/projects', async (req, res, next) => {
    try { const result = validateProjectInput(req.body); if (!result.valid) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: result.errors });
      res.status(201).json(summary(await projectService.createProject(result.project)));
    } catch (e) { next(e); }
  });
  app.get('/api/projects/:id', async (req, res, next) => { try { const project = await repository.get(req.params.id); if (!project) return res.status(404).json({ error: 'Project not found.' }); res.json(summary(project)); } catch (e) { next(e); } });
  app.patch('/api/projects/:id/tasks/:taskId', async (req, res, next) => {
    try {
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
      const task = allTasks(project).find(candidate => candidate.id === req.params.taskId);
      if (!task) return res.status(404).json({ error: 'Task not found.' });
      const provider = req.body && req.body.provider;
      if (provider !== undefined && (typeof provider !== 'string' || !provider.trim() || provider.length > 50)) return res.status(400).json({ error: 'provider must be a non-empty string up to 50 characters.' });
      const result = await execution.executeTask(project, task, { provider: provider || 'template' });
      if (result.blocked) return res.status(409).json(result);
      if (result.failed) return res.status(500).json(result);
      res.status(201).json(result);
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
      res.json(project.runs || []);
    } catch (e) { next(e); }
  });
  app.delete('/api/projects/:id', async (req, res, next) => { try { if (!await repository.delete(req.params.id)) return res.status(404).json({ error: 'Project not found.' }); res.status(204).end(); } catch (e) { next(e); } });
  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'An unexpected server error occurred.' }); });
  return app;
}
module.exports = { createApp };
