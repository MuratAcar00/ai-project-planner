const transitions = {
  idle: ['generating_ideas'], generating_ideas: ['evaluating'], evaluating: ['planning'],
  planning: ['executing'], executing: ['testing', 'fixing'], testing: ['fixing', 'completed'],
  fixing: ['executing', 'testing'], paused: [], completed: [], failed: []
};
function transition(run, state) {
  if (run.state === state) return;
  if (['completed', 'failed'].includes(run.state) || (!['paused', 'failed'].includes(state) && !transitions[run.state]?.includes(state))) {
    throw new Error(`Invalid autonomous transition: ${run.state} -> ${state}.`);
  }
  run.state = state;
}
function event(run, type, details = {}) {
  run.events.push({ id: `${run.id}-event-${run.events.length + 1}`, type, timestamp: new Date().toISOString(),
    runId: run.id, projectId: run.projectId || null, ...details });
}
module.exports = { transition, event };
