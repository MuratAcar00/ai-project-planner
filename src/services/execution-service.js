const { createRun, startRun, completeRun, failRun } = require('../domain');

const allTasks = project => project.plan.phases.flatMap(phase => phase.tasks);
const updateProjectStatus = project => {
  const tasks = allTasks(project);
  project.status = tasks.length && tasks.every(task => task.completed) ? 'Completed' : 'In progress';
};

class ExecutionService {
  constructor({ projectRepository, providers }) {
    this.projectRepository = projectRepository;
    this.providers = new Map(providers.map(provider => [provider.name, provider]));
  }

  async executeTask(project, task, { provider = 'template' } = {}) {
    const executor = this.providers.get(provider);
    if (!executor) throw new Error(`Unknown execution provider: ${provider}.`);

    const dependencyIds = Array.isArray(task.dependencies) ? task.dependencies : [];
    const dependencies = allTasks(project).filter(candidate => dependencyIds.includes(candidate.id));
    const missingDependencyIds = dependencyIds.filter(id => !dependencies.some(dependency => dependency.id === id));
    const incomplete = dependencies.filter(dependency => !dependency.completed);
    if (incomplete.length || missingDependencyIds.length) {
      const labels = [
        ...incomplete.map(dependency => dependency.title),
        ...missingDependencyIds.map(id => `missing task ${id}`)
      ];
      const message = `Task is blocked by incomplete dependencies: ${labels.join(', ')}.`;
      const updated = await this.updateTask(project.id, task.id, storedTask => {
        storedTask.status = 'blocked';
        storedTask.completed = false;
        storedTask.error = message;
        return { task: storedTask, run: null, blocked: true, error: message };
      });
      return updated;
    }

    const run = startRun(createRun({
      projectId: project.id,
      type: 'task-execution',
      taskId: task.id,
      provider: executor.name,
      input: { taskId: task.id, title: task.title }
    }));
    await this.updateTask(project.id, task.id, storedTask => {
      storedTask.status = 'running';
      storedTask.completed = false;
      storedTask.error = null;
      storedTask.startedAt = run.startedAt;
      return { task: storedTask };
    }, run);

    try {
      const output = await executor.executeTask(task, { projectId: project.id, runId: run.id });
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
      const failedRun = failRun(run, { message });
      return await this.updateTask(project.id, task.id, storedTask => {
        storedTask.status = 'failed';
        storedTask.completed = false;
        storedTask.error = message;
        storedTask.completedAt = failedRun.completedAt;
        return { task: storedTask, run: failedRun, blocked: false, failed: true, error: message };
      }, failedRun);
    }
  }

  async updateTask(projectId, taskId, resultFactory, run) {
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
