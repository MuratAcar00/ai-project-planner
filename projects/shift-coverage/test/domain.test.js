'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError, saveRecord, removeRecord, coverage, summary } = require('../src/domain');
const { fixture } = require('./helpers/fixture');
const rejects = (operation, status) => assert.throws(operation, (error) => error instanceof AppError && error.status === status);

test('coverage is chronological, event scoped and reflects assignment removal', () => {
  const { state, event, volunteer, shift } = fixture();
  const other = saveRecord(state, 'events', { name: 'Other' });
  const early = saveRecord(state, 'shifts', { ...Object.fromEntries(Object.entries(shift).filter(([key]) => key !== 'id')), eventId: other.id, startsAt: '2026-10-01T08:00:00+01:00' });
  assert.equal(early.startsAt, '2026-10-01T07:00:00.000Z');
  const assignment = saveRecord(state, 'assignments', { shiftId: shift.id, volunteerId: volunteer.id });
  assert.deepEqual(coverage(state).map((item) => item.id), [early.id, shift.id]);
  assert.equal(coverage(state, event.id)[0].covered, true);
  assert.match(summary(state, event.id), /1\/1 assigned \| 0 uncovered \| Volunteers: Alex/);
  assert.doesNotMatch(summary(state, event.id), /Other/);
  removeRecord(state, 'assignments', assignment.id);
  assert.equal(coverage(state, event.id)[0].uncovered, 1);
  assert.match(summary(state, event.id), /Volunteers: None/);
  rejects(() => summary(state, 'missing'), 404);
  assert.equal(summary({ ...state, shifts: [] }), 'Shift Coverage\nNo shifts defined.\n');
});

test('assignment updates enforce uniqueness and capacity without changing rejected records', () => {
  const { state, volunteer, shift } = fixture();
  const second = saveRecord(state, 'volunteers', { name: 'Sam' });
  const assignment = saveRecord(state, 'assignments', { shiftId: shift.id, volunteerId: volunteer.id });
  assert.equal(saveRecord(state, 'assignments', {}, assignment.id).id, assignment.id);
  const before = structuredClone(state);
  for (const id of [volunteer.id, second.id]) rejects(() => saveRecord(state, 'assignments', { shiftId: shift.id, volunteerId: id }), 409);
  rejects(() => saveRecord(state, 'shifts', { eventId: 'missing' }, shift.id), 404);
  assert.deepEqual(state, before);
});

for (const collection of ['events', 'shifts', 'volunteers']) test(`deleting ${collection} cascades only affected records`, () => {
  const { state, event, volunteer, shift } = fixture();
  saveRecord(state, 'assignments', { shiftId: shift.id, volunteerId: volunteer.id });
  const unrelated = saveRecord(state, 'events', { name: 'Keep me' });
  removeRecord(state, collection, { events: event, shifts: shift, volunteers: volunteer }[collection].id);
  assert.equal(state.assignments.length, 0);
  assert.ok(state.events.some((item) => item.id === unrelated.id));
  assert.equal(state.shifts.length, collection === 'volunteers' ? 1 : 0);
  rejects(() => removeRecord(state, collection, 'missing'), 404);
});

test('validation rejects invalid input atomically and accepts documented bounds', () => {
  const { state, shift } = fixture();
  for (const body of [null, [], 1, 'name', {}, { name: ' ' }, { name: 1 }, { name: 'a\u0000b' }, { name: 'a'.repeat(201) }, { name: 'ok', id: 'supplied' }]) {
    const before = structuredClone(state);
    rejects(() => saveRecord(state, 'volunteers', body), 400);
    assert.deepEqual(state, before);
  }
  assert.equal(saveRecord(state, 'volunteers', { name: '  Alex  ' }).name, 'Alex');
  assert.equal(saveRecord(state, 'events', { name: 'a'.repeat(200), location: '' }).name.length, 200);
  for (const patch of [{ capacity: '2' }, { capacity: null }, { capacity: -1 }, { capacity: 1001 }, { capacity: 1.5 }, { startsAt: '2026-10-01T10:00:00' }, { startsAt: '2026-02-30T10:00:00Z' }, { endsAt: shift.startsAt }]) {
    const before = structuredClone(state);
    rejects(() => saveRecord(state, 'shifts', patch, shift.id), 400);
    assert.deepEqual(state, before);
  }
  assert.equal(saveRecord(state, 'shifts', { capacity: 1000 }, shift.id).capacity, 1000);
  state.volunteers = Array.from({ length: 10000 }, (_, id) => ({ id: String(id), name: 'Person' }));
  rejects(() => saveRecord(state, 'volunteers', { name: 'Overflow' }), 409);
});
