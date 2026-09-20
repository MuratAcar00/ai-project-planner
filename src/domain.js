const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const TASK_STATUSES = ['pending', 'ready', 'running', 'completed', 'failed', 'blocked'];
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];

function createRequirements(description) {
  return {
    id: makeId('requirements'),
    problemStatement: description,
    items: []
  };
}

function createTask({
  id = makeId('task'),
  title,
  description = '',
  status,
  estimate,
  completed,
  priority = null,
  dependencies = [],
  acceptanceCriteria = [],
  result = null,
  error = null,
  startedAt = null,
  completedAt = null,
  ...attributes
}) {
  const resolvedStatus = TASK_STATUSES.includes(status) ? status : (completed ? 'completed' : 'pending');
  return {
    ...attributes,
    id,
    title,
    description,
    status: resolvedStatus,
    estimate,
    completed: resolvedStatus === 'completed',
    priority,
    dependencies: Array.isArray(dependencies) ? dependencies : [],
    acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
    result,
    error,
    startedAt,
    completedAt
  };
}

function createPhase({ name, goal, tasks = [], ...attributes }) {
  return { ...attributes, name, goal, tasks: tasks.map(task => createTask(task)) };
}

function createPlan({ id = makeId('plan'), phases = [], ...attributes }) {
  return {
    id,
    ...attributes,
    phases: phases.map(phase => createPhase(phase)),
  };
}

function createRun({ projectId, type, taskId = null, provider = null, input = null, output = null, error = null }) {
  return {
    id: makeId('run'),
    projectId,
    type,
    status: 'pending',
    taskId,
    provider,
    input,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    output,
    error
  };
}

function startRun(run) {
  return { ...run, status: 'running', startedAt: new Date().toISOString() };
}

function completeRun(run, output = null) {
  return { ...run, status: 'completed', completedAt: new Date().toISOString(), output, error: null };
}

function failRun(run, error = null) {
  return { ...run, status: 'failed', completedAt: new Date().toISOString(), error };
}

function createProject({ id = makeId('project'), input, plan, run }) {
  return {
    id,
    ...input,
    status: 'Planning',
    createdAt: new Date().toISOString(),
    requirements: createRequirements(input.description),
    plan,
    runs: run ? [run] : []
  };
}

module.exports = { TASK_STATUSES, RUN_STATUSES, makeId, createRequirements, createTask, createPhase, createPlan, createRun, startRun, completeRun, failRun, createProject };
