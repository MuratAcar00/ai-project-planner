const test = require('node:test');
const assert = require('node:assert/strict');
const { runSummary, eventSummary } = require('../src/autonomous/presentation');

test('safe run summaries map every lifecycle state and expose only appropriate controls', () => {
  const states = { generating_ideas: 'Generating ideas', evaluating: 'Checking previous projects / Evaluating candidates', planning: 'Planning', executing: 'Building', testing: 'Testing', fixing: 'Fixing', paused: 'Paused', completed: 'Completed', failed: 'Failed' };
  for (const [state, label] of Object.entries(states)) {
    const dto = runSummary({ id: 'run', state, error: 'private', pendingFailure: { output: 'private' } });
    assert.equal(dto.label, label);
    assert.equal(dto.canResume, state === 'paused');
    assert.equal(dto.canPause, !['paused', 'completed', 'failed'].includes(state));
    assert.equal(JSON.stringify(dto).includes('private'), false);
  }
  const attention = runSummary({ state: 'paused', needsAttention: true });
  assert.equal(attention.label, 'Needs Attention');
  assert.equal(attention.canResume, false);
});

test('summaries resolve current phase/task and timeline without serializing evidence', () => {
  const project = { name: 'Decision Log', status: 'In progress', plan: { phases: [{ name: 'Backend', tasks: [{ id: 'a', title: 'API', completed: true }, { id: 'b', title: 'Tests', status: 'running' }] }] } };
  const run = { id: 'run', state: 'executing', selection: { selected: { name: 'Decision Log', oneLinePitch: 'Track decisions' } } };
  const dto = runSummary(run, project);
  assert.equal(dto.currentPhase, 'Backend');
  assert.equal(dto.currentTask, 'Tests');
  assert.equal(dto.progress, 50);
  assert.equal(dto.completedTasks, 1);
  assert.deepEqual(runSummary({ state: 'completed' }).codexUsage, { codexCallsTotal: 0, buildCalls: 0, repairCalls: 0, failedCalls: 0 });
  assert.deepEqual(runSummary({ state: 'completed' }).codexBudget, { buildCalls: 3, repairCalls: 2 });
  assert.deepEqual(runSummary({ state: 'completed', codexUsage: { codexCallsTotal: 2, buildCalls: 1, repairCalls: 1, failedCalls: 1 } }).codexUsage,
    { codexCallsTotal: 2, buildCalls: 1, repairCalls: 1, failedCalls: 1 });
  const event = eventSummary({ id: 'event', type: 'task_started', taskId: 'b', timestamp: '2026-01-01T00:00:00Z', output: 'PRIVATE' }, run, project);
  assert.equal(event.message, 'Task started: Tests');
  assert.equal(event.timestamp, '2026-01-01T00:00:00Z');
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
  const noProgress = eventSummary({ id: 'event-no-progress', type: 'repair_no_progress', reason: 'Repair made no progress: failure and workspace are unchanged.', timestamp: '2026-01-01T00:00:00Z' }, run, project);
  assert.equal(noProgress.message, 'Repair made no progress: failure and workspace are unchanged.');
});
