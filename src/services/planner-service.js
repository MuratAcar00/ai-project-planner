class PlannerService {
  constructor({ providers }) {
    this.providers = new Map(providers.map(provider => [provider.name, provider]));
  }

  async generatePlan(projectInput, { provider = 'template' } = {}) {
    const planner = this.providers.get(provider);
    if (!planner) throw new Error(`Unknown planner provider: ${provider}.`);
    const plan = await planner.generatePlan(projectInput);
    return { plan, provider: planner.name };
  }
}

module.exports = { PlannerService };
