const TARGET_PLATFORMS = ['web', 'mobile', 'web_mobile'];

// Choose from the product's core workflow and audience. Routine record keeping,
// reporting and team administration fit a web workspace; field work and
// personal, on-the-go workflows benefit from native mobile access.
function chooseTargetPlatform(idea) {
  const text = [idea.targetUser, idea.problem, idea.solution, idea.coreWorkflow,
    ...(idea.coreFeatures || [])].filter(Boolean).join(' ').toLowerCase();
  const mobile = /field|on-the-go|on the go| unterwegs|travel|commut|location|gps|camera|offline|in-person|in person|learner|lesson|tutor|volunteer|freelancer|tradespeople|workshop|equipment/.test(text);
  const web = /dashboard|team|admin|analytics|report|approval|newsletter|inventory|ecommerce|customer support|shift|capacity|decision|project|release|document|subscription|quote/.test(text);
  if (mobile && web) return 'web_mobile';
  return mobile ? 'mobile' : 'web';
}

function validTargetPlatform(value) { return TARGET_PLATFORMS.includes(value); }
function projectTargetPlatform(project) { return validTargetPlatform(project?.targetPlatform) ? project.targetPlatform : 'web'; }

module.exports = { TARGET_PLATFORMS, chooseTargetPlatform, validTargetPlatform, projectTargetPlatform };
