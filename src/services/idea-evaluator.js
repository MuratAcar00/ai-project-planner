const { IdeaNoveltyService } = require('./idea-novelty-service');
class IdeaEvaluator {
  evaluate(idea) {
    const rating = value => Number.isInteger(value) && value >= 1 && value <= 5;
    if (!idea || !['complexity', 'testability', 'deploymentSimplicity', 'usefulness', 'differentiation'].every(key => rating(idea[key])) ||
        !Array.isArray(idea.coreFeatures) || !idea.coreFeatures.length || !Array.isArray(idea.externalDependencies) ||
        typeof idea.paidApiRequired !== 'boolean' || !Number.isInteger(idea.estimatedTasks) || idea.estimatedTasks < 1) throw new Error('Invalid idea evaluation data.');
    const criteria = {
      mvpScope: idea.coreFeatures.length <= 4 && idea.estimatedTasks <= 6 ? 15 : 5,
      implementationComplexity: (6 - idea.complexity) * 3,
      externalDependencies: idea.externalDependencies.length === 0 ? 15 : 0,
      paidApiRequirement: idea.paidApiRequired ? 0 : 15,
      testability: idea.testability * 2,
      deploymentSimplicity: idea.deploymentSimplicity * 2,
      usefulness: idea.usefulness * 3,
      differentiation: idea.differentiation
    };
    const eligible = !idea.paidApiRequired && idea.externalDependencies.length === 0 && idea.estimatedTasks <= 6 && idea.complexity <= 3;
    return { ideaId: idea.id, eligible, score: Object.values(criteria).reduce((sum, value) => sum + value, 0), criteria,
      reason: eligible ? 'Small, testable MVP with no external services or paid APIs; ranked by weighted feasibility.' : 'Excluded: exceeds local MVP scope or needs external/paid services.' };
  }
  select(ideas, history = []) {
    if (!Array.isArray(ideas) || !ideas.length || ideas.length > 3) throw new Error('Expected 1–3 candidate ideas.');
    const novelty = new IdeaNoveltyService();
    const evaluations = ideas.map(idea => {
      const evaluation = this.evaluate(idea);
      const check = novelty.check(idea, history);
      return { ...evaluation, eligible: evaluation.eligible && !check.duplicate, duplicate: check.duplicate,
        score: evaluation.score + check.novelty + check.diversity,
        criteria: { ...evaluation.criteria, novelty: check.novelty, diversity: check.diversity } };
    });
    const ranked = evaluations.filter(item => item.eligible).sort((a, b) => b.score - a.score || a.ideaId.localeCompare(b.ideaId));
    if (!ranked.length) return { evaluations, selected: null, reason: 'No unique eligible MVP idea.' };
    return { evaluations, selected: ideas.find(idea => idea.id === ranked[0].ideaId), reason: `${ranked[0].reason} Score ${ranked[0].score}/116; ties use idea ID.` };
  }
}
module.exports = { IdeaEvaluator };
