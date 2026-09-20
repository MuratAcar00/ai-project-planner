const { createProject, createPlan, createRun, startRun, completeRun, failRun, makeId } = require('../domain');

class ProjectService {
  constructor({ projectRepository, plannerService }) {
    this.projectRepository = projectRepository;
    this.plannerService = plannerService;
  }

  async createProject(input) {
    const projectId = makeId('project');
    let run = startRun(createRun({ projectId, type: 'plan-generation' }));

    try {
      const generated = await this.plannerService.generatePlan(input);
      const plan = createPlan({
        ...generated.plan,
        id: makeId('plan'),
        provider: generated.provider,
        generatedAt: new Date().toISOString()
      });
      run = completeRun(run, { provider: generated.provider, planId: plan.id });
      return this.projectRepository.create(createProject({ id: projectId, input, plan, run }));
    } catch (error) {
      run = failRun(run, { message: error.message });
      throw error;
    }
  }
}

module.exports = { ProjectService };
