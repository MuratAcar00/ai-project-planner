// Explicit browser DTOs: never spread persisted execution/validation records.
const labels = { idle: 'Starting', generating_ideas: 'Generating ideas', evaluating: 'Checking previous projects / Evaluating candidates', planning: 'Planning', executing: 'Building', testing: 'Testing', fixing: 'Fixing', paused: 'Paused', completed: 'Completed', failed: 'Failed' };
const text = value => typeof value === 'string' ? value.slice(0, 500) : null;
function runSummary(run, project) {
  const phases = project?.plan?.phases || [];
  const tasks = phases.flatMap(phase => phase.tasks);
  const completed = tasks.filter(task => task.completed).length;
  const current = tasks.find(task => task.status === 'running') || tasks.find(task => !task.completed);
  const attention = Boolean(run.needsAttention);
  return { id: run.id, projectId: run.projectId, name: text(project?.name || run.selection?.selected?.name) || 'New SaaS',
    selectedIdea: text(run.selection?.selected?.oneLinePitch), state: run.state,
    label: attention ? 'Needs Attention' : labels[run.state] || 'Unknown', needsAttention: attention,
    projectStatus: project?.status || 'Planning', progress: tasks.length ? Math.round(completed / tasks.length * 100) : 0,
    completedTasks: completed, totalTasks: tasks.length, currentPhase: text(phases.find(phase => phase.tasks.includes(current))?.name) || labels[run.state],
    currentTask: text(current?.title), fixAttempts: run.fixAttempts || 0, createdAt: run.createdAt,
    completedAt: run.completedAt || null, updatedAt: run.updatedAt,
    canPause: !['paused', 'completed', 'failed'].includes(run.state), canResume: run.state === 'paused' && !attention };
}
function eventSummary(event, run, project) {
  const task = project?.plan?.phases.flatMap(phase => phase.tasks).find(task => task.id === event.taskId);
  const names = { checking_history: 'Checking previous projects', evaluating_candidates: 'Evaluating candidates', selecting_idea: 'Selecting new idea', rejected_as_duplicate: `Duplicate idea rejected: ${text(event.ideaName) || 'Candidate'}`, run_created: 'Run created', idea_generated: 'Idea generated', idea_selected: `${text(run.selection?.selected?.name) || 'Idea'} selected — ideas evaluated`,
    project_created: 'Project, requirements and workspace created', plan_created: 'Development plan created', task_started: 'Task started', task_completed: 'Task completed', task_failed: 'Task failed',
    validation_started: 'Tests running', validation_passed: 'Validation passed', validation_failed: 'Validation failed', fix_started: 'Repair started',
    failure_analyzed: 'Failure reviewed', project_completed: 'Project completed', project_failed: 'Project failed', run_paused: 'Run paused', run_resumed: 'Run resumed',
    run_recovered: 'Interrupted run paused after restart', infrastructure_recovered: 'Infrastructure reconciled', approval_allowed: 'Local action authorized', approval_denied: 'Operator authorization required' };
  return { id: event.id, type: event.type, timestamp: event.timestamp,
    message: event.type === 'state_changed' ? `Stage: ${labels[event.to] || 'Updated'}` : `${names[event.type] || 'Run updated'}${task ? `: ${text(task.title)}` : ''}` };
}
module.exports = { runSummary, eventSummary };
