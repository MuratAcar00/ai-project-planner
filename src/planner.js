const uuid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function task(title, estimate) {
  return { id: uuid(), title, estimate, completed: false };
}

function generatePlan({ name, description, platform, technology, experienceLevel }) {
  const platformArchitecture = {
    Web: 'Client-server web application with a responsive browser client and REST API.',
    Mobile: 'Mobile-first client application consuming a versioned REST API.',
    Desktop: 'Desktop client with a local service layer and optional cloud synchronization.',
    'API / Backend': 'Layered REST API with routing, services, and a persistence boundary.'
  }[platform];
  const difficulty = experienceLevel === 'Beginner' ? 'Moderate — build incrementally and keep the first release focused.' : experienceLevel === 'Advanced' ? 'Challenging — optimize for maintainability, security, and scale.' : 'Moderate to challenging — plan milestones and validate assumptions early.';
  const techNote = technology === 'Other' ? 'Choose a stable ecosystem that matches your team’s constraints.' : `Use ${technology} for the primary implementation.`;
  const phases = [
    { name: 'Discovery & scope', goal: 'Turn the idea into a small, testable first release.', tasks: [task('Define users, primary problem, and success criteria', '2–3 hours'), task('Write core user stories and prioritize an MVP', '3–4 hours'), task('List non-functional requirements and project risks', '1–2 hours')] },
    { name: 'Design & foundation', goal: 'Create the technical and visual foundation.', tasks: [task('Sketch information architecture and key user flows', '3–5 hours'), task(`Set up the ${technology} project, linting, and environment configuration`, '2–3 hours'), task('Design data models and API contracts', '3–4 hours')] },
    { name: 'Core development', goal: 'Implement the highest-value end-to-end functionality.', tasks: [task('Build the primary user workflow', '1–2 days'), task('Implement data validation and helpful error states', '3–5 hours'), task('Add persistence and secure data access patterns', '4–6 hours')] },
    { name: 'Quality & release', goal: 'Verify the product and make it ready to ship.', tasks: [task('Write automated tests for critical workflows', '4–6 hours'), task('Perform accessibility, responsive, and manual testing', '3–4 hours'), task('Prepare production configuration and release notes', '2–3 hours')] }
  ];
  return {
    overview: `${name} is a ${platform.toLowerCase()} project: ${description}`,
    architecture: platformArchitecture,
    technologyStack: [techNote, 'RESTful JSON API for application communication.', 'JSON-backed local persistence for the initial release.', 'Automated tests for core API behavior.'],
    phases,
    difficulty,
    testingStrategy: ['Unit-test validation and planning rules.', 'Integration-test create, read, update, and delete API paths.', 'Manually test the primary workflow on desktop and mobile viewport sizes.'],
    deploymentChecklist: ['Set production environment variables.', 'Confirm error responses do not expose internal details.', 'Back up the project data file.', 'Run the full test suite.', 'Start the service and verify the health endpoint.']
  };
}

module.exports = { generatePlan };
