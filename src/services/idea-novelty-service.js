const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stop = new Set('a an the and or to of for in with as is are create edit export track show local dashboard app users user'.split(' '));
const tokens = value => new Set(normalize(value).split(' ').filter(word => word && !stop.has(word)).map(word => word.replace(/(ing|es|s)$/, '')));
function similarity(a, b) {
  const left = tokens(a); const right = tokens(b);
  if (!left.size || !right.size) return 0;
  return 2 * [...left].filter(word => right.has(word)).length / (left.size + right.size);
}
class IdeaNoveltyService {
  async history(projectRepository, runRepository, excludeRunId) {
    const [projects, runs] = await Promise.all([projectRepository.list(), runRepository.list()]);
    const entries = projects.filter(p => !excludeRunId || p.autonomousRunId !== excludeRunId).map(p => p.idea || runs.find(run => run.id === p.autonomousRunId)?.selection?.selected || { name: p.name, problem: p.description });
    for (const run of runs) {
      if (run.id !== excludeRunId && run.selection?.selected && !projects.some(p => p.autonomousRunId === run.id)) entries.push(run.selection.selected);
    }
    return entries;
  }
  check(idea, history) {
    const workflow = item => [item.coreWorkflow, item.solution, ...(item.coreFeatures || [])].filter(Boolean).join(' ');
    const duplicate = history.some(previous => {
      if (normalize(idea.name) && normalize(idea.name) === normalize(previous.name)) return true;
      if (idea.problemKey && idea.problemKey === previous.problemKey) return true;
      const problem = similarity(idea.problem, previous.problem);
      const user = similarity(idea.targetUser, previous.targetUser);
      const flow = similarity(workflow(idea), workflow(previous));
      return problem >= 0.8 || (problem >= 0.5 && flow >= 0.5) || (flow >= 0.8 && user >= 0.5);
    });
    const domain = idea.domain || (normalize(idea.name) === 'decision log' ? 'project-management' : null);
    const used = domain ? history.filter(item => (item.domain || (normalize(item.name) === 'decision log' ? 'project-management' : null)) === domain).length : 0;
    return { duplicate, novelty: duplicate ? 0 : 10, diversity: domain ? Math.max(0, 6 - used * 2) : 0 };
  }
}
module.exports = { IdeaNoveltyService, normalize, similarity };
