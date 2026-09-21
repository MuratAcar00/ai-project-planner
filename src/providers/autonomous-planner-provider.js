const { makeId } = require('../domain');
class AutonomousPlannerProvider {
  constructor() { this.name = 'autonomous'; }
  async generatePlan(input) {
    const specification = `${input.name}: ${input.description}`;
    const contract = 'Use zero-dependency Node.js CommonJS with built-in http, plain HTML/CSS/JS. package.json scripts must be start: node src/server.js, test: node --test test/*.test.js, optional build: node --check src/server.js. No dependencies, install scripts, external APIs, accounts, secrets or network integrations. Export createServer() from src/app.js returning an unlistened HTTP server. GET /api/health returns {status:"ok"}. Use workspace-local data with injectable temporary storage for tests. Use local assets, bounded validation and safe text rendering. No deploy or git operations.';
    const definitions = [
      ['Foundation', 'Implement domain, persistence and HTTP API', `Implement the complete backend for ${specification}. ${contract} Add testable data models, CRUD API and error handling.`, ['Primary domain operations work', 'Input validation and persistence tests pass']],
      ['Product', 'Implement responsive product dashboard', `Build a polished, accessible browser UI for ${specification}. Consume the existing API. Include loading, errors, empty states and mobile layout. ${contract}`, ['Every core feature works end to end', 'No placeholder controls or invented data']],
      ['Quality', 'Test critical workflows and error paths', `Review and test ${specification}. Implement node:test tests for domain, API, validation and persistence using isolated workspace-local temporary data. Include real HTTP tests where available. Fix detected product defects. ${contract}`, ['Automated tests cover success and failure cases', 'Tests do not access production data']],
      ['Delivery', 'Complete README and acceptance review', `Review the MVP for ${specification}. Fix remaining defects and write README with setup, tests, architecture, API, privacy and limitations. ${contract}`, ['README includes runnable instructions', 'Tests pass and no unfinished features remain']]
    ];
    let previous;
    return { overview: specification, architecture: contract, phases: definitions.map(([name, title, description, acceptanceCriteria]) => {
      const id = makeId('task');
      const task = { id, title, description, acceptanceCriteria, dependencies: previous ? [previous] : [] };
      previous = id;
      return { name, goal: title, tasks: [task] };
    }) };
  }
}
module.exports = { AutonomousPlannerProvider };
