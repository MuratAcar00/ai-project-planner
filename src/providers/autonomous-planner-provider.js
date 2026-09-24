const { makeId } = require('../domain');
class AutonomousPlannerProvider {
  constructor() { this.name = 'autonomous'; }
  async generatePlan(input) {
    const specification = `${input.name}: ${input.description}`;
    const contract = 'Use zero-dependency Node.js CommonJS with built-in http, plain HTML/CSS/JS. package.json scripts must be start: node src/server.js, test: node --test test/*.test.js, optional build: node --check src/server.js. No dependencies, install scripts, external APIs, accounts, secrets or network integrations. Export createServer() from src/app.js returning an unlistened HTTP server. GET /api/health returns {status:"ok"}. Use workspace-local data with injectable temporary storage for tests. Use local assets, bounded validation and safe text rendering. No deploy or git operations.';
    const definitions = [
      ['Foundation', 'Build the application foundation', `Implement the project scaffold, domain and data model, persistence, backend/API, validation, error handling, and foundational backend tests for ${specification}. ${contract}`, ['Primary domain operations work', 'Input validation and persistence tests pass']],
      ['Product', 'Build the product interface and workflows', `Implement a polished, accessible frontend/UI for ${specification}, integrate it with the API, and complete the core user workflows. Include loading, error and empty states plus a responsive, mobile-friendly layout. ${contract}`, ['Every core feature works end to end', 'No placeholder controls or invented data']],
      ['Quality', 'Verify and prepare the finished product', `Review ${specification}; add node:test coverage for critical success and error paths using isolated temporary data; fix remaining implementation defects; and prepare a final acceptance review. Write a runnable README covering setup, architecture, API, privacy and limitations. ${contract}`, ['Automated tests cover critical success and error paths', 'Tests do not access production data', 'README includes runnable instructions']]
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
