const { createRun, startRun, completeRun, failRun } = require('../domain');

const allTasks = project => project.plan.phases.flatMap(phase => phase.tasks);
const updateProjectStatus = project => {
  const tasks = allTasks(project);
  project.status = !project.autonomousRunId && tasks.length && tasks.every(task => task.completed) ? 'Completed' : 'In progress';
};

class ExecutionService {
  constructor({ projectRepository, providers, workspaceService = null, jobTimeoutMs = 65 * 60 * 1000 }) {
    this.projectRepository = projectRepository;
    this.providers = new Map(providers.map(provider => [provider.name, provider]));
    this.workspaceService = workspaceService;
    this.jobTimeoutMs = jobTimeoutMs;
    this.jobs = new Map();
    this.initialization = null;
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = this.recoverInterrupted();
      this.initialization.catch(() => {});
    }
    return this.initialization;
  }

  async recoverInterrupted() {
    for (const project of await this.projectRepository.list()) {
      await this.projectRepository.update(project.id, stored => {
        const interrupted = (stored.runs || []).some(run => run.type === 'task-execution' && run.status === 'running')
          || allTasks(stored).some(task => task.status === 'running');
        if (!interrupted) return false;
        const message = 'Execution interrupted by server restart.';
        stored.runs = (stored.runs || []).map(run => run.type === 'task-execution' && run.status === 'running'
          ? failRun(run, { message }) : run);
        for (const task of allTasks(stored)) {
          if (task.status !== 'running') continue;
          Object.assign(task, { status: 'failed', completed: false, error: message, completedAt: new Date().toISOString() });
        }
        updateProjectStatus(stored);
        return true;
      });
    }
  }

  async executeTask(project, task, options) {
    const result = await this.startTask(project, task, options);
    return result.run && !result.duplicate ? this.jobs.get(result.run.id) || result : result;
  }

  async startTask(project, task, { provider = 'template', timeoutMs } = {}) {
    await this.initialize();
    const executor = this.providers.get(provider);
    if (!executor) throw new Error(`Unknown execution provider: ${provider}.`);
    const run = startRun(createRun({
      projectId: project.id,
      type: 'task-execution',
      taskId: task.id,
      provider: executor.name,
      input: { taskId: task.id, title: task.title }
    }));
    let accepted;
    const updated = await this.projectRepository.update(project.id, stored => {
      const current = allTasks(stored).find(candidate => candidate.id === task.id);
      if (!current) return false;
      const active = (stored.runs || []).find(candidate => candidate.taskId === task.id && candidate.status === 'running');
      if (active) {
        accepted = { task: current, run: active, duplicate: true, error: 'Task execution is already running.' };
        return true;
      }
      const dependencies = current.dependencies || [];
      const incomplete = dependencies.filter(id => !allTasks(stored).some(candidate => candidate.id === id && candidate.completed));
      if (incomplete.length) {
        const labels = incomplete.map(id => allTasks(stored).find(candidate => candidate.id === id)?.title || `missing task ${id}`);
        const error = `Task is blocked by incomplete dependencies: ${labels.join(', ')}.`;
        Object.assign(current, { status: 'blocked', completed: false, error });
        accepted = { task: current, run: null, blocked: true, error };
      } else {
        Object.assign(current, { status: 'running', completed: false, error: null, result: null, completedAt: null, startedAt: run.startedAt });
        stored.runs ||= [];
        stored.runs.push(run);
        task = structuredClone(current);
        accepted = { task: structuredClone(current), run, blocked: false };
      }
      updateProjectStatus(stored);
      return true;
    });
    if (updated === null) throw new Error('Project not found.');
    if (updated === false) throw new Error('Task not found.');
    if (accepted.blocked || accepted.duplicate) return accepted;
    const job = new Promise(resolve => setImmediate(resolve))
      .then(() => this.runTask(project, task, executor, run, timeoutMs))
      .catch(() => {
        // Persistent storage failure: report no sensitive provider details.
        console.error('Execution terminal state could not be persisted; restart recovery is required.');
        return { failed: true, error: 'Execution state persistence failed.' };
      })
      .finally(() => this.jobs.delete(run.id));
    this.jobs.set(run.id, job);
    return accepted;
  }

  async runTask(project, task, executor, run, timeoutMs) {
    let timer;
    let expired = false;
    try {
      const work = async () => {
        const workspacePath = executor.requiresWorkspace ? await this.resolveWorkspace(project.id) : undefined;
        if (expired) throw new Error('Execution job timed out.');
        return executor.executeTask(task, { projectId: project.id, runId: run.id, workspacePath, timeoutMs });
      };
      const output = await Promise.race([
        work(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error('Execution job timed out.'));
          }, this.jobTimeoutMs);
        })
      ]);
      const completedRun = completeRun(run, output);
      return await this.updateTask(project.id, task.id, storedTask => {
        storedTask.status = 'completed';
        storedTask.completed = true;
        storedTask.result = output;
        storedTask.error = null;
        storedTask.completedAt = completedRun.completedAt;
        return { task: storedTask, run: completedRun, blocked: false };
      }, completedRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Task execution failed.';
      const executionResult = error && error.executionResult;
      const failedRun = failRun(run, { message, ...(executionResult ? { output: executionResult } : {}) });
      return await this.updateTask(project.id, task.id, storedTask => {
        storedTask.status = 'failed';
        storedTask.completed = false;
        storedTask.error = message;
        if (executionResult) storedTask.result = executionResult;
        storedTask.completedAt = failedRun.completedAt;
        return { task: storedTask, run: failedRun, blocked: false, failed: true, error: message };
      }, failedRun);
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveWorkspace(projectId) {
    if (!this.workspaceService) throw new Error('No workspace service is configured for this execution provider.');
    return this.workspaceService.getWorkspacePath(projectId);
  }

  async updateTask(projectId, taskId, resultFactory, run) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.persistTask(projectId, taskId, resultFactory, run); }
      catch (error) { if (attempt >= 2) throw error; }
    }
  }

  async persistTask(projectId, taskId, resultFactory, run) {
    let result;
    const updated = await this.projectRepository.update(projectId, project => {
      const storedTask = allTasks(project).find(candidate => candidate.id === taskId);
      if (!storedTask) return false;
      if (run) {
        project.runs ||= [];
        const runIndex = project.runs.findIndex(candidate => candidate.id === run.id);
        if (runIndex >= 0) project.runs[runIndex] = run;
        else project.runs.push(run);
      }
      result = resultFactory(storedTask);
      updateProjectStatus(project);
      return true;
    });
    if (updated === null) throw new Error('Project not found.');
    if (updated === false) throw new Error('Task not found.');
    return result;
  }
}

module.exports = { ExecutionService, allTasks, updateProjectStatus };
