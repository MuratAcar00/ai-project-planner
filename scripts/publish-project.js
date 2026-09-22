// Trusted local operator entry point. Never constructs an app or starts execution.
const path = require('node:path');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { JsonAutonomousRunRepository } = require('../src/repositories/json-autonomous-run-repository');
const { WorkspaceService } = require('../src/services/workspace-service');
const { GeneratedProjectPublisher } = require('../src/services/generated-project-publisher');
const root = path.resolve(__dirname, '..');
async function main() {
  const [action, id, ...extra] = process.argv.slice(2);
  if (!['--dry-run', '--publish'].includes(action) || !id || extra.length) throw Error('Usage: node scripts/publish-project.js --dry-run|--publish PROJECT_ID');
  const publisher = new GeneratedProjectPublisher({
    projectRepository: new JsonProjectRepository(path.join(root, 'data/projects.json')),
    runRepository: new JsonAutonomousRunRepository(path.join(root, 'data/autonomous-runs.json')),
    workspaceService: new WorkspaceService({ workspaceRoot: path.join(root, 'workspaces') })
  });
  console.log(JSON.stringify(await publisher[action === '--dry-run' ? 'dryRun' : 'publish'](id), null, 2));
}
main().catch(error => { console.error(error.safePublishError ? error.message : 'Publishing stopped. Check local repository configuration.'); process.exitCode = 1; });
