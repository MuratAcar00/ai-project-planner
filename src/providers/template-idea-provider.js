const { IdeaProvider } = require('./idea-provider');

const templates = [
  ['scope-board', 'Scope Board', 'Keep small client projects within scope.', 'Freelance designers', 'Scope changes get lost in email.', 'Track deliverables and change requests in a local dashboard.', ['Create and edit projects with deliverables', 'Record and classify change requests', 'Show scope and completion summary', 'Export a project summary'], 'Optional team subscription in a future version', 2, 5, 5],
  ['decision-log', 'Decision Log', 'Remember why your team made a decision.', 'Small product teams', 'Decision context disappears between meetings.', 'Capture decisions, alternatives and review dates.', ['Create and edit decisions', 'Tag and search decisions', 'Track review dates', 'Export decisions as JSON'], 'Optional shared workspaces in a future version', 1, 5, 4],
  ['renewal-desk', 'Renewal Desk', 'See upcoming renewals before they surprise you.', 'Independent consultants', 'Small recurring subscriptions are hard to track.', 'Organize manually entered recurring costs and renewal dates.', ['Record subscriptions and renewal dates', 'Compute monthly and annual totals', 'Filter upcoming renewals', 'Export a cost summary'], 'Optional multi-user plan in a future version', 2, 4, 4]
];
class TemplateIdeaProvider extends IdeaProvider {
  constructor() { super(); this.name = 'template'; }
  async generateIdeas({ candidateCount = 3 } = {}) {
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > templates.length) throw new Error('candidateCount must be between 1 and 3.');
    return templates.slice(0, candidateCount).map(([id, name, oneLinePitch, targetUser, problem, solution, coreFeatures, monetization, complexity, usefulness, differentiation]) => ({
      id, name, oneLinePitch, targetUser, problem, solution, coreFeatures: [...coreFeatures], monetization,
      complexity, estimatedTasks: 4, generatedAt: new Date().toISOString(),
      externalDependencies: [], paidApiRequired: false, testability: 5, deploymentSimplicity: 5, usefulness, differentiation
    }));
  }
}
module.exports = { TemplateIdeaProvider };
