class FailureAnalyzer {
  analyze(failure) {
    const output = failure.output || {};
    const message = [failure.message || 'Unknown failure', output.stderr || ''].join('\n').slice(0, 6000);
    const infrastructure = failure.infrastructureError === true || output.infrastructureError === true || ['spawn_error', 'process_error', 'stream_error'].includes(output.terminationReason) || /CLI is not installed|Unable to start Codex|sandbox unavailable|Git metadata requires operator review|Bubblewrap is unavailable|Validation sandbox could not start|Sandbox stream failed|workspace.*not.*exist|state persistence failed|double-loading config|Exit prior to config file resolving|Read-only file system|EROFS|bwrap:|failed to find\s+\\?["']?(?:which|java|javac)\\?["']?\s+in (?:the )?search path|(?:unable to locate|could not find|failed to locate)\s+(?:a\s+)?(?:java|jdk|jre)(?:\s+(?:runtime|development kit|installation|executable))?|(?:java|jdk|jre)\s+(?:runtime|installation|executable).{0,60}(?:not found|unavailable|could not be found)|(?:java\.lang\.)?InternalError:?\s*Error loading java\.security file|(?:error|failed|unable) (?:loading|to load|opening|reading).{0,80}(?:java\.security|java\.policy|nss\.cfg)|(?:java\.security|java\.policy|nss\.cfg).{0,100}(?:not found|no such file|permission denied|read-only file system)|failed to connect to websocket|stream disconnected before completion|failed to initialize.*(?:app-server|sandbox)|(?:Codex|sandbox|runtime).*initialization fail|spawn.*(?:EACCES|EPERM|ENOENT)/i.test(message);
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
