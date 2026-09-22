const { randomInt } = require('node:crypto');
const { IdeaProvider } = require('./idea-provider');
// Each recipe keeps the problem, audience and workflow together. Variants are
// useful reporting views, not new identities for an already used problem.
const recipes = [
  ['developer-tools', 'release-readiness', 'Release Checklist', 'Small software teams', 'Release prerequisites are missed during handoffs', 'Record a release, check prerequisites and review blockers', ['Record releases and owners', 'Maintain prerequisite checklists', 'Review unresolved blockers']],
  ['education', 'lesson-feedback', 'Lesson Pulse', 'Independent tutors', 'Lesson feedback is scattered and follow-up practice is forgotten', 'Record lesson observations and assign follow-up practice', ['Record learners and lessons', 'Capture structured observations', 'Track practice follow-ups']],
  ['small-business', 'quote-followup', 'Quote Followup', 'Independent tradespeople', 'Unanswered customer estimates lose potential jobs', 'Record estimates and schedule customer follow-ups', ['Record estimates and customer contacts', 'Track quote stages', 'List overdue follow-ups']],
  ['content-workflows', 'editorial-approval', 'Editorial Queue', 'Small newsletter teams', 'Draft approvals block publication without clear ownership', 'Submit drafts, assign reviewers and resolve approval blockers', ['Record draft briefs', 'Assign approval owners', 'Track review status']],
  ['analytics', 'experiment-results', 'Experiment Ledger', 'Small ecommerce operators', 'Marketing experiment results lack comparable baselines', 'Enter experiment baselines and outcomes to compare changes', ['Record experiment hypotheses', 'Enter baseline and outcome metrics', 'Compute outcome differences']],
  ['local-business', 'equipment-maintenance', 'Service Calendar', 'Local workshop owners', 'Equipment maintenance is missed until machines stop working', 'Register equipment, schedule service and record maintenance', ['Register equipment', 'Schedule maintenance intervals', 'Record service history']],
  ['document-workflows', 'document-expiry', 'Document Watch', 'Small office administrators', 'Expiring business documents are discovered too late', 'Register document metadata and review upcoming expiry dates', ['Register document metadata without uploads', 'Track expiry dates and owners', 'Filter upcoming renewals']],
  ['inventory-operations', 'stock-reorder', 'Restock Board', 'Small craft retailers', 'Low-stock items are noticed after orders cannot be filled', 'Record stock movements and review reorder needs', ['Register items and minimum levels', 'Record stock movements', 'Calculate reorder quantities']],
  ['customer-support', 'support-handoff', 'Handoff Inbox', 'Small customer support teams', 'Unresolved customer requests lose context between shifts', 'Record requests, assign owners and prepare shift handoffs', ['Record customer requests', 'Assign owners and statuses', 'Summarize unresolved handoffs']],
  ['planning-tools', 'volunteer-coverage', 'Shift Coverage', 'Community event organizers', 'Volunteer coverage gaps appear too late before events', 'Define shifts, assign volunteers and review coverage gaps', ['Define event shifts and capacity', 'Assign volunteers', 'Highlight uncovered shifts']],
  ['personal-productivity', 'weekly-capacity', 'Capacity Planner', 'Independent freelancers', 'Weekly commitments exceed available working hours', 'Enter available hours, estimate commitments and rebalance the week', ['Set weekly available hours', 'Estimate commitments', 'Compare workload with capacity']],
  ['project-management', 'decision-context', 'Decision Log', 'Small product teams', 'Decision context disappears between meetings.', 'Capture decisions, alternatives and review dates.', ['Create and edit decisions', 'Tag and search decisions', 'Track review dates']]
];
class LocalIdeaProvider extends IdeaProvider {
  constructor({ offset = randomInt(recipes.length) } = {}) { super(); this.name = 'local'; this.offset = offset; }
  async generateIdeas({ candidateCount = 3, batch = 1, history = [] } = {}) {
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 3) throw new Error('candidateCount must be between 1 and 3.');
    const ordered = recipes.map((recipe, index) => ({ recipe, order: (index - this.offset + recipes.length) % recipes.length }))
      .sort((a, b) => history.filter(h => h.domain === a.recipe[0]).length - history.filter(h => h.domain === b.recipe[0]).length || a.order - b.order);
    return Array.from({ length: candidateCount }, (_, index) => {
      const [domain, problemKey, name, targetUser, problem, coreWorkflow, features] = ordered[((batch - 1) * candidateCount + index) % ordered.length].recipe;
      const report = domain === 'analytics' ? 'Export experiment comparisons' : 'Export a concise workflow summary';
      return { id: problemKey, name, domain, problemKey, targetUser, problem, coreWorkflow, solution: coreWorkflow,
        oneLinePitch: `${name}: ${problem.toLowerCase()}.`, coreFeatures: [...features, report], mvpScope: [...features, report],
        differentiators: ['Focused workflow with explicit ownership and actionable summary', 'Local data entry; no external integrations required'],
        monetization: 'Optional per-workspace subscription for shared team use', complexity: 2, usefulness: 5, differentiation: 4,
        estimatedTasks: 4, testability: 5, deploymentSimplicity: 5, externalDependencies: [], paidApiRequired: false, generatedAt: new Date().toISOString() };
    });
  }
}
module.exports = { LocalIdeaProvider };
