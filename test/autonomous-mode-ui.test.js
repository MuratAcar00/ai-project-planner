const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function ui() {
  const elements = new Map();
  for (const id of ['mode-start', 'mode-max', 'mode-attention', 'mode-publish', 'mode-status']) elements.set('#' + id, { disabled: false, innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const context = vm.createContext({ document: { querySelector: selector => elements.get(selector) }, window: { addEventListener() {} }, Date, setTimeout, clearTimeout });
  // Exercise actual dashboard rendering without network, routing or a DOM dependency.
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\nroute\(\);\s*$/, '\n');
  vm.runInContext(source, context);
  return { elements, render(mode) { context.modeFixture = mode; vm.runInContext('renderAutonomousMode(modeFixture, () => {}, false)', context); } };
}

test('Autonomous Mode dashboard renders separate session progress, controls and escaped project history', () => {
  const f = ui();
  const session = { id: 'session-1', createdAt: '2026-09-22T12:00:00.000Z', status: 'running', maxProjects: 5, completedProjects: 2, failedProjects: 0, progress: 40,
    stopOnNeedsAttention: true, autoPublish: false, nextAction: 'Continue current project', current: { name: '<script>alert(1)</script>', label: 'Building', currentTask: 'Build dashboard' },
    projects: [{ runId: 'run-1', name: '<img src=x>', status: 'completed' }] };
  f.render({ active: true, session });
  const html = f.elements.get('#mode-status').innerHTML;
  assert.match(html, /2 \/ 5 projects completed/); assert.match(html, /40%/);
  assert.match(html, /data-mode-action="pause"/); assert.match(html, /data-mode-action="stop"/);
  assert.match(html, /#\/run\/run-1/); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x>'));
  assert.equal(f.elements.get('#mode-start').disabled, true);
  assert.equal(f.elements.get('#mode-max').value, 5); assert.equal(f.elements.get('#mode-publish').checked, false);
  f.render({ active: true, session: { ...session, status: 'paused' } });
  assert.match(f.elements.get('#mode-status').innerHTML, /data-mode-action="resume"/);
  f.render({ active: false, session: { ...session, status: 'completed' } });
  assert.equal(f.elements.get('#mode-start').disabled, false);
  assert.ok(!f.elements.get('#mode-status').innerHTML.includes('data-mode-action='));
});
