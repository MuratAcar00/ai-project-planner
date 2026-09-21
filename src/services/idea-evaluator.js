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
  select(ideas) {
    if (!Array.isArray(ideas) || !ideas.length || ideas.length > 3) throw new Error('Expected 1–3 candidate ideas.');
    const evaluations = ideas.map(idea => this.evaluate(idea));
    const ranked = evaluations.filter(item => item.eligible).sort((a, b) => b.score - a.score || a.ideaId.localeCompare(b.ideaId));
    if (!ranked.length) throw new Error('No eligible MVP idea.');
    return { evaluations, selected: ideas.find(idea => idea.id === ranked[0].ideaId), reason: `${ranked[0].reason} Score ${ranked[0].score}/100; ties use idea ID.` };
  }
}
module.exports = { IdeaEvaluator };
