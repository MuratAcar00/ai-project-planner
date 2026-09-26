// Explicit browser DTOs: never spread persisted execution/validation records.
const labels = { idle: 'Starting', generating_ideas: 'Generating ideas', evaluating: 'Checking previous projects / Evaluating candidates', planning: 'Planning', executing: 'Building', testing: 'Testing', fixing: 'Fixing', paused: 'Paused', completed: 'Completed', failed: 'Failed', abandoned: 'Abandoned' };
const text = value => typeof value === 'string' ? value.slice(0, 500) : null;
const { CODEX_BUDGET } = require('./codex-budget');
const { projectTargetPlatform } = require('./platform');
const { blocksNewAutonomousRun } = require('../services/autonomous-project-service');
const codexUsage = run => Object.fromEntries(['codexCallsTotal', 'buildCalls', 'repairCalls', 'failedCalls'].map(key => [key, Number.isInteger(run.codexUsage?.[key]) && run.codexUsage[key] >= 0 ? run.codexUsage[key] : 0]));
function runSummary(run, project, { manual = false, canRetryValidation = false } = {}) {
  const phases = project?.plan?.phases || [];
  const tasks = phases.flatMap(phase => phase.tasks);
  const completed = tasks.filter(task => task.completed).length;
  const current = tasks.find(task => task.status === 'running') || tasks.find(task => !task.completed);
  const attention = Boolean(run.needsAttention);
  const mobile = projectTargetPlatform(project || { targetPlatform: run.selection?.selected?.targetPlatform }) === 'mobile';
  const latestValidation = run.validationResults?.at(-1);
  const flutterTest = latestValidation?.checks?.find(check => check.name === 'flutter-test');
  const apkCheck = latestValidation?.checks?.find(check => check.name === 'android-debug-apk');
  const apkStatus = latestValidation?.artifactStatus?.androidApk?.status
    || (apkCheck?.passed ? 'built' : apkCheck ? (apkCheck.infrastructureError ? 'infrastructure-unavailable' : 'build-failed') : 'not-built');
  const apkLabels = { built: 'Built', 'not-built': 'Not built', 'infrastructure-unavailable': 'Infrastructure unavailable', 'build-failed': 'Build failed' };
  const requestedPlatform = run.platformPreference || run.config?.platformPreference || 'auto';
  const platformPreference = ['auto', 'web', 'mobile', 'web_mobile'].includes(requestedPlatform) ? requestedPlatform : 'auto';
  return { id: run.id, projectId: run.projectId, name: text(project?.name || run.selection?.selected?.name) || 'New SaaS', platformPreference,
    selectedIdea: text(run.selection?.selected?.oneLinePitch), targetPlatform: projectTargetPlatform(project || { targetPlatform: run.selection?.selected?.targetPlatform }), state: run.state,
    label: attention ? 'Needs Attention' : labels[run.state] || 'Unknown', needsAttention: attention,
    projectStatus: project?.status || 'Planning', progress: tasks.length ? Math.round(completed / tasks.length * 100) : 0,
    completedTasks: completed, totalTasks: tasks.length, codexUsage: codexUsage(run), codexBudget: CODEX_BUDGET, currentPhase: text(phases.find(phase => phase.tasks.includes(current))?.name) || labels[run.state],
    currentTask: text(current?.title), fixAttempts: run.fixAttempts || 0, createdAt: run.createdAt,
    completedAt: run.completedAt || null, updatedAt: run.updatedAt,
    applicationValidationStatus: mobile ? (flutterTest?.passed && latestValidation?.passed ? 'Passed' : flutterTest ? 'Failed' : 'Not run') : null,
    androidApkStatus: mobile ? (apkLabels[apkStatus] || 'Not built') : null,
    canPause: !['paused', 'completed', 'failed', 'abandoned'].includes(run.state), canResume: run.state === 'paused' && !attention,
    canAbandon: manual && run.state === 'paused' && !attention, canRetryValidation: manual && canRetryValidation,
    blocksNewRun: blocksNewAutonomousRun(run) };
}
function eventSummary(event, run, project) {
  const task = project?.plan?.phases.flatMap(phase => phase.tasks).find(task => task.id === event.taskId);
  const names = { checking_history: 'Checking previous projects', evaluating_candidates: 'Evaluating candidates', selecting_idea: 'Selecting new idea', rejected_as_duplicate: `Duplicate idea rejected: ${text(event.ideaName) || 'Candidate'}`, run_created: 'Run created', idea_generated: 'Idea generated', idea_selected: `${text(run.selection?.selected?.name) || 'Idea'} selected — ideas evaluated`,
    project_created: 'Project, requirements and workspace created', plan_created: 'Development plan created', task_started: 'Task started', task_completed: 'Task completed', task_failed: 'Task failed',
    validation_started: 'Tests running', validation_passed: 'Validation passed', validation_failed: 'Validation failed', fix_started: 'Repair started',
    failure_analyzed: 'Failure reviewed', codex_budget_exhausted: 'Codex call budget exhausted', repair_no_progress: 'Repair made no progress', project_completed: 'Project completed', project_failed: 'Project failed', run_paused: 'Run paused', run_resumed: 'Run resumed', run_abandoned: 'Run abandoned', validation_infrastructure_retry_started: 'Validation infrastructure recovery started',
    run_recovered: 'Interrupted run paused after restart', infrastructure_recovered: 'Infrastructure reconciled', approval_allowed: 'Local action authorized', approval_denied: 'Operator authorization required' };
  return { id: event.id, type: event.type, timestamp: event.timestamp,
    message: event.type === 'state_changed' ? `Stage: ${labels[event.to] || 'Updated'}` : ['codex_budget_exhausted', 'repair_no_progress'].includes(event.type) ? text(event.reason) : `${names[event.type] || 'Run updated'}${task ? `: ${text(task.title)}` : ''}` };
}
module.exports = { runSummary, eventSummary, codexUsage };
