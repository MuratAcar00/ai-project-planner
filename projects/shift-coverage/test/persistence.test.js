'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/store');
const { saveRecord } = require('../src/domain');
const { temporary, fixture } = require('./helpers/fixture');

test('round trip preserves references and isolates returned values and failed mutations', (t) => {
  const file = temporary(t);
  const store = createStore(file);
  const { state, shift, volunteer } = fixture();
  saveRecord(state, 'assignments', { shiftId: shift.id, volunteerId: volunteer.id });
  store.mutate((next) => Object.assign(next, state));
  assert.deepEqual(createStore(file).read(), state);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.mutate((next) => { next.events.length = 0; throw new Error('Abort'); }), /Abort/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(store.read(), state);
  const result = store.mutate((next) => saveRecord(next, 'events', { name: 'New' }));
  result.name = 'Outside mutation';
  assert.equal(store.read().events.at(-1).name, 'New');
});

test('write failures preserve memory and remove temporary files', (t) => {
  const file = temporary(t);
  const store = createStore(file);
  fs.mkdirSync(file);
  assert.throws(() => store.mutate((next) => saveRecord(next, 'events', { name: 'Cannot save' })));
  assert.deepEqual(store.read().events, []);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

for (const kind of ['json', 'shape', 'duplicate', 'reference', 'capacity', 'unknown-field']) test(`corrupt storage (${kind}) is rejected without overwriting it`, (t) => {
  const file = temporary(t);
  const { state } = fixture();
  if (kind === 'duplicate') state.events.push({ ...state.events[0] });
  if (kind === 'reference') state.shifts[0].eventId = 'missing';
  if (kind === 'capacity') state.shifts[0].capacity = 0;
  if (kind === 'unknown-field') state.volunteers[0].unexpected = true;
  const raw = kind === 'json' ? '{' : kind === 'shape' ? '{}' : JSON.stringify(state);
  fs.writeFileSync(file, raw);
  assert.throws(() => createStore(file), /Unable to load coverage storage/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
