const { makeId } = require('../domain');
const { projectTargetPlatform } = require('../autonomous/platform');
class AutonomousPlannerProvider {
  constructor() { this.name = 'autonomous'; }
  async generatePlan(input) {
    const targetPlatform = projectTargetPlatform(input);
    const specification = `${input.name}: ${input.description} (target: ${targetPlatform})`;
    const security = 'Keep the implementation local and bounded. Do not add secrets, credentials, external accounts or network integrations. Validate inputs, avoid unsafe rendering, keep data workspace-local, and use isolated temporary storage in tests. Do not deploy or run git operations.';
    const web = 'Build the web app with the existing zero-dependency Node.js CommonJS server using built-in http and plain HTML/CSS/JavaScript. package.json scripts: start: node src/server.js, test: node --test test/*.test.js, optional build: node --check src/server.js. Export createServer() from src/app.js returning an unlistened HTTP server. GET /api/health returns {status:"ok"}.';
    const mobile = 'Plan a Flutter application for both Android and iOS using Dart. Describe the Flutter app structure, platform-aware UI/navigation, and Android+iOS validation tasks. Flutter tooling and real app generation are not part of this plan; do not add Flutter dependencies or claim they are installed.';
    const contract = targetPlatform === 'web' ? `${web} ${security}` : targetPlatform === 'mobile' ? `${mobile} ${security}` : `${web} Also plan a Flutter application for Android and iOS using Dart. Share a backend/API between web and mobile clients when that suits the product; otherwise explain the boundary. Plan API contracts and integration across clients. Flutter tooling and real app generation are not part of this plan. ${security}`;
    const definitions = targetPlatform === 'web' ? [
      ['Foundation', 'Build the Node.js web foundation', `Implement the Node.js/JavaScript web scaffold, domain model, local persistence, HTTP API, bounded validation, safe error handling, and foundational backend tests for ${specification}. ${contract}`, ['Node.js web server and API support the core domain operations', 'Input validation and persistence tests pass']],
      ['Product', 'Build the web product workflows', `Implement an accessible browser interface in plain HTML, CSS, and JavaScript for ${specification}; integrate it with the Node.js API and complete the core workflows. Include loading, error, empty and responsive states. ${contract}`, ['Every core feature works end to end in the browser', 'No placeholder controls or invented data']],
      ['Quality', 'Verify the web application', `Review ${specification}; add node:test coverage for critical success and error paths using isolated temporary data; fix remaining defects; and prepare a final acceptance review. Write a runnable README covering Node.js setup, architecture, API, privacy and limitations. ${contract}`, ['Automated tests cover critical success and error paths', 'Tests do not access production data', 'README includes runnable Node.js instructions']]
    ] : targetPlatform === 'mobile' ? [
      ['Foundation', 'Build the Flutter foundation', `Define the Flutter/Dart app structure, domain models, state and data boundaries, input validation, and error handling for ${specification}. Plan Android and iOS app configuration and focused foundation tests without generating the app yet. ${contract}`, ['Flutter architecture covers Android and iOS', 'Domain, validation and error behavior are specified']],
      ['Product', 'Build the Android and iOS product workflows', `Plan the Flutter UI and implement the core user workflows for ${specification}, including navigation, accessible controls, loading, error and empty states, and platform-appropriate Android and iOS behavior. ${contract}`, ['Core workflows are specified for Android and iOS', 'No placeholder controls or invented data']],
      ['Quality', 'Verify the Flutter product plan', `Define unit and widget test coverage for critical success and error paths, and Android and iOS acceptance checks for ${specification}. Review privacy, platform configuration and limitations, and document setup and architecture without claiming Flutter is installed. ${contract}`, ['Tests cover critical success and error paths', 'Android and iOS acceptance checks are documented', 'README describes setup, architecture, privacy and limitations']]
    ] : [
      ['Foundation', 'Build the shared web and mobile foundation', `Define the web backend/API and the Flutter/Dart Android+iOS client boundaries, domain model, shared API contracts, persistence, validation, error handling and foundational tests for ${specification}. Share one backend/API when appropriate; document any product-specific reason to separate it. ${contract}`, ['Web and Flutter clients have explicit architecture and API contracts', 'Validation and persistence behavior is testable']],
      ['Product', 'Build the web and mobile product workflows', `Plan and implement the browser client in plain HTML/CSS/JavaScript and the Flutter workflows for Android and iOS for ${specification}. Integrate both clients with the backend/API where appropriate; include navigation, accessibility, loading, error, empty and responsive states. ${contract}`, ['Core workflows are represented on web, Android and iOS', 'Clients use the documented API contracts', 'No placeholder controls or invented data']],
      ['Quality', 'Verify all target platforms', `Add node:test coverage for backend/API success and error paths using isolated temporary data; define Flutter unit/widget tests and Android/iOS acceptance checks; verify client integration, privacy and limitations. Document setup and architecture without claiming Flutter is installed. ${contract}`, ['Backend tests cover critical success and error paths', 'Android and iOS checks and client integration are documented', 'Tests do not access production data']]
    ];
    let previous;
    return { overview: specification, architecture: contract, targetPlatform, phases: definitions.map(([name, title, description, acceptanceCriteria]) => {
      const id = makeId('task');
      const task = { id, title, description, acceptanceCriteria, dependencies: previous ? [previous] : [] };
      previous = id;
      return { name, goal: title, tasks: [task] };
    }) };
  }
}
module.exports = { AutonomousPlannerProvider };
