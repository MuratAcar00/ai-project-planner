// Read-only: never instantiate the orchestrator, project service or executor.
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalIdeaProvider } = require('../src/providers/local-idea-provider');
const { IdeaNoveltyService } = require('../src/services/idea-novelty-service');
const { IdeaEvaluator } = require('../src/services/idea-evaluator');
async function main() {
  const read = file => fs.readFile(path.join(__dirname, '..', 'data', file), 'utf8').then(JSON.parse);
  const [projects, runs] = await Promise.all([read('projects.json'), read('autonomous-runs.json')]);
  const history = await new IdeaNoveltyService().history({ list: async () => projects }, { list: async () => runs });
  // Fixed rotation deliberately includes the legacy duplicate in the smoke batch.
  const provider = new LocalIdeaProvider({ offset: 11 });
  const candidates = await provider.generateIdeas({ history });
  const selection = new IdeaEvaluator().select(candidates, history);
  console.log(JSON.stringify({ mode: 'read-only selection; no project creation or execution',
    historyHasDecisionLog: history.some(idea => idea.name === 'Decision Log'),
    candidates: candidates.map(idea => ({ name: idea.name, domain: idea.domain })),
    rejected: selection.evaluations.filter(item => item.duplicate).map(item => candidates.find(idea => idea.id === item.ideaId).name),
    selected: selection.selected?.name || null }, null, 2));
  if (!selection.selected || selection.selected.name === 'Decision Log') process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
