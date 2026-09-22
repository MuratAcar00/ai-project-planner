'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// A small DOM stand-in exercises asynchronous UI behavior without dependencies.
function dashboard(fetch) {
  class Element {
    constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    querySelector(tag) { return this.children.find((child) => child.tag === tag); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement(tag) { return new Element(tag); }
  };
  document.getElementById('error').append(new Element('span'));
  const context = vm.createContext({ document, fetch, AbortSignal, Intl, Date, setTimeout, Option: function(text, value) { return { textContent: text, value }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  return { elements, run: (code) => vm.runInContext(code, context) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (body) => ({ ok: true, status: 200, json: async () => body });

test('failed initial loading disables stale controls and retry restores an actionable empty state', async () => {
  let failing = true;
  const ui = dashboard(async () => { if (failing) throw new Error('Offline'); return response([]); });
  await settle();
  assert.equal(ui.elements.get('dashboard').inert, true);
  assert.match(ui.elements.get('loading').textContent, /unavailable/);
  assert.match(ui.elements.get('error').children[0].textContent, /Offline/);
  failing = false;
  await ui.run('load()');
  assert.equal(ui.elements.get('dashboard').inert, false);
  assert.equal(ui.elements.get('loading').hidden, true);
  assert.equal(ui.elements.get('new-event').disabled, false);
  assert.equal(ui.elements.get('new-shift').disabled, true);
  assert.equal(ui.elements.get('export').disabled, true);
  assert.equal(ui.elements.get('shifts').children[0].children[2].textContent, 'Create an event');
});

test('latest refresh wins when requests resolve out of order', async () => {
  const pending = [];
  const ui = dashboard(() => new Promise((resolve) => pending.push(resolve)));
  const latest = ui.run('load()');
  pending.slice(4).forEach((resolve, index) => resolve(response(index === 0 ? [{ id: 'new', name: 'Current event' }] : [])));
  await latest;
  pending.slice(0, 4).forEach((resolve, index) => resolve(response(index === 0 ? [{ id: 'old', name: 'Stale event' }] : [])));
  await settle();
  assert.equal(ui.elements.get('event').value, 'new');
  assert.equal(ui.elements.get('dashboard').inert, false);
});

test('coverage totals, gap filter, and user text reflect API data', async () => {
  const data = {
    events: [{ id: 'event', name: 'Picnic', location: 'Park' }], volunteers: [{ id: 'v', name: '<img src=x onerror=alert(1)>' }],
    assignments: [{ id: 'a', volunteerId: 'v', shiftId: 'full' }],
    coverage: [
      { id: 'full', eventId: 'event', title: 'Welcome', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', assigned: 1, capacity: 1, uncovered: 0, covered: true },
      { id: 'open', eventId: 'event', title: 'Cleanup', startsAt: '2026-10-01T11:00:00Z', endsAt: '2026-10-01T12:00:00Z', assigned: 0, capacity: 3, uncovered: 3, covered: false }
    ]
  };
  const ui = dashboard(async (url) => response(data[url.slice(5)]));
  await settle();
  assert.equal(ui.elements.get('coverage-progress').value, 25);
  assert.equal(ui.elements.get('gaps').textContent, 3);
  assert.equal(ui.elements.get('volunteers').children[0].children[1].textContent, data.volunteers[0].name);
  ui.elements.get('gaps-only').checked = true;
  ui.run('render()');
  assert.equal(ui.elements.get('shifts').children.length, 1);
  assert.equal(ui.elements.get('shifts').children[0].children[0].children[0].children[0].textContent, 'Cleanup');
});
