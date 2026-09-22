const { createApp } = require('./app');
const { ApprovalGate } = require('./services/approval-gate');
const port = process.env.PORT || 3000;
// Trusted operator configuration, never accepted from the browser.
const app = createApp({ approvalGate: new ApprovalGate({ allowCodexExecution: process.env.FACTORY_ALLOW_CODEX_EXECUTION === 'true' }) });
const server = app.listen(port, () => console.log(`Autonomous App Factory running at http://localhost:${server.address().port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await app.locals.runtime.close();
  server.closeAllConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
