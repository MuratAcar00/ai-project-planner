class FailureAnalyzer {
  analyze(failure) {
    const message = String(failure.message || 'Unknown failure').slice(0, 3000);
    const infrastructure = /CLI is not installed|sandbox unavailable|workspace.*not.*exist|state persistence failed/i.test(message);
    let category = failure.kind === 'task' ? 'implementation' : 'validation';
    const check = failure.checkName || '';
    if (check === 'install' || check === 'contract') category = 'package-contract';
    if (check.startsWith('syntax:')) category = 'syntax';
    if (check === 'tests') category = 'tests';
    if (check === 'startup-health') category = 'startup';
    const recommendations = {
      implementation: 'Inspect the failed task requirements and current workspace; repair the implementation before retrying the original task.',
      validation: 'Inspect the failing validation evidence and preserve all passing checks.',
      'package-contract': 'Restore the zero-dependency package and fixed script contract; do not fetch packages or add lifecycle scripts.',
      syntax: 'Repair the reported JavaScript syntax error and check related modules.',
      tests: 'Find the product defect exposed by the tests. Preserve assertions; do not skip or remove tests to obtain a pass.',
      startup: 'Fix application startup and the /api/health contract without external services.'
    };
    return { category: infrastructure ? 'infrastructure' : category, recoverable: !infrastructure, evidence: message,
      recommendation: infrastructure ? 'Pause for operator review; code changes cannot repair missing execution infrastructure.' : recommendations[category] };
  }
}
module.exports = { FailureAnalyzer };
