const express = require('express');
const path = require('node:path');
const { ProjectStore } = require('./store');
const { validateProjectInput } = require('./validation');
const { generatePlan } = require('./planner');

const makeId = () => `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const summary = project => {
  const tasks = project.plan.phases.flatMap(phase => phase.tasks);
  const completedTasks = tasks.filter(task => task.completed).length;
  return { ...project, completedTasks, remainingTasks: tasks.length - completedTasks, progress: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0 };
};

function createApp({ dataFile } = {}) {
  const app = express();
  const store = new ProjectStore(dataFile || path.join(__dirname, '..', 'data', 'projects.json'));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/projects', async (req, res, next) => { try { res.json((await store.list()).map(summary)); } catch (e) { next(e); } });
  app.post('/api/projects', async (req, res, next) => {
    try { const result = validateProjectInput(req.body); if (!result.valid) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: result.errors });
      const project = { id: makeId(), ...result.project, status: 'Planning', createdAt: new Date().toISOString(), plan: generatePlan(result.project) };
      res.status(201).json(summary(await store.create(project)));
    } catch (e) { next(e); }
  });
  app.get('/api/projects/:id', async (req, res, next) => { try { const project = await store.get(req.params.id); if (!project) return res.status(404).json({ error: 'Project not found.' }); res.json(summary(project)); } catch (e) { next(e); } });
  app.patch('/api/projects/:id/tasks/:taskId', async (req, res, next) => {
    try { if (typeof req.body.completed !== 'boolean') return res.status(400).json({ error: 'completed must be a boolean.' });
      const updated = await store.update(req.params.id, project => { const task = project.plan.phases.flatMap(p => p.tasks).find(t => t.id === req.params.taskId); if (!task) return false; task.completed = req.body.completed; project.status = project.plan.phases.flatMap(p => p.tasks).every(t => t.completed) ? 'Completed' : 'In progress'; return true; });
      if (updated === null) return res.status(404).json({ error: 'Project not found.' });
      if (updated === false) return res.status(404).json({ error: 'Task not found.' }); res.json(summary(updated));
    } catch (e) { next(e); }
  });
  app.delete('/api/projects/:id', async (req, res, next) => { try { if (!await store.delete(req.params.id)) return res.status(404).json({ error: 'Project not found.' }); res.status(204).end(); } catch (e) { next(e); } });
  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'An unexpected server error occurred.' }); });
  return app;
}
module.exports = { createApp };
