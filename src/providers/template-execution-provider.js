const { ExecutionProvider } = require('./execution-provider');

class TemplateExecutionProvider extends ExecutionProvider {
  constructor() {
    super('template');
  }

  async executeTask(task, context = {}) {
    return {
      taskId: task.id,
      projectId: context.projectId,
      events: ['task received', 'execution started', 'execution completed'],
      message: `Template execution completed for task: ${task.title}.`
    };
  }
}

module.exports = { TemplateExecutionProvider };
