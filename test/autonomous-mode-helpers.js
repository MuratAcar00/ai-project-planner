const fs = require('node:fs/promises');
const path = require('node:path');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { JsonFactorySessionRepository } = require('../src/repositories/json-factory-session-repository');
const { AutonomousModeService } = require('../src/services/autonomous-mode-service');

async function modeFixture(t, options = {}) {
  const root = path.resolve('.test-tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'mode-'));
  const sessionRepository = new JsonFactorySessionRepository(path.join(directory, 'sessions.json'));
  const runRepository = new JsonProjectRepository(path.join(directory, 'runs.json'));
  const projectRepository = new JsonProjectRepository(path.join(directory, 'projects.json'));
  const calls = [], published = [];
  let maxConcurrent = 0;
  const autonomousService = {
    runRepository, jobs: new Map(), async initialize() {},
    async start(config) {
      const runs = await runRepository.list();
      const existing = runs.find(run => run.config.requestId === config.requestId) || runs.find(run => !['completed', 'failed'].includes(run.state));
      if (existing) return { run: existing, duplicate: true };
      const number = calls.length + 1;
      const run = { id: `run-${number}`, projectId: `project-${number}`, config, state: 'executing', validationPassed: false, createdAt: new Date().toISOString() };
      await runRepository.create(run);
      await projectRepository.create({ id: run.projectId, autonomousRunId: run.id, name: `Project ${String.fromCharCode(64 + number)}`, status: 'In progress', plan: { phases: [{ name: 'Build', tasks: [{ title: 'Build dashboard', status: 'running' }] }] } });
      calls.push(run.id); this.jobs.set(run.id, true);
      maxConcurrent = Math.max(maxConcurrent, this.jobs.size);
      return { run, duplicate: false };
    },
    async pause(id) {
      return runRepository.update(id, run => { run.resumeState = run.state; run.state = 'paused'; run.pauseReason = 'Paused by user.'; return true; });
    },
    async resume(id) {
      if (this.jobs.has(id)) throw new Error('Must settle first');
      this.jobs.set(id, true);
      return runRepository.update(id, run => { run.state = run.resumeState || 'executing'; return true; });
    }
  };
  const publisher = { async publish(id) { published.push(id); if (options.publish) return options.publish(id); return { publishStatus: 'published' }; }, async status() { return { publishStatus: options.published ? 'published' : 'needs_attention' }; } };
  const dependencies = { sessionRepository, autonomousService, projectRepository, publisher, pollMs: 60000 };
  const service = new AutonomousModeService(dependencies);
  const services = [service];
  t.after(async () => { for (const mode of services) await mode.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function settle(state = 'completed', extra = {}) {
    const session = await service.active();
    const id = session.currentRunId;
    await runRepository.update(id, run => { Object.assign(run, { state, validationPassed: state === 'completed', ...extra }); return true; });
    const run = await runRepository.get(id);
    await projectRepository.update(run.projectId, project => { project.status = state === 'completed' ? 'Completed' : 'Needs attention'; return true; });
    autonomousService.jobs.delete(id);
  }
  return { service, dependencies, directory, calls, published, settle, maxConcurrent: () => maxConcurrent, async restart({ crash = false } = {}) {
    if (crash) { clearTimeout(service.timer); service.closed = true; }
    else await service.close();
    const restarted = new AutonomousModeService(dependencies); services.push(restarted); await restarted.initialize(); return restarted;
  } };
}
module.exports = { modeFixture };
