const { generatePlan } = require('../planner');

class TemplatePlannerProvider {
  constructor() {
    this.name = 'template';
  }

  async generatePlan(projectInput) {
    return generatePlan(projectInput);
  }
}

module.exports = { TemplatePlannerProvider };
