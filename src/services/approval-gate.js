const LOCAL_ACTIONS = new Set(['generate_ideas', 'plan_project', 'workspace_code', 'workspace_test', 'workspace_fix']);
// Only explicit operator configuration can authorize use of the installed Codex account.
// External actions have no executor in this version and are always denied.
class ApprovalGate {
  constructor({ allowCodexExecution = false } = {}) { this.allowCodexExecution = allowCodexExecution === true; }
  check(action) {
    const allowed = LOCAL_ACTIONS.has(action) || (['codex_execution', 'operator_recovery', 'operator_repair_grant'].includes(action) && this.allowCodexExecution);
    return { action, allowed, reason: allowed ? 'Authorized local operation.' : 'Denied by default; explicit operator approval is required.' };
  }
}
module.exports = { ApprovalGate };
