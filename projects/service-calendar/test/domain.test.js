'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, createRecord, equipmentView, HttpError } = require('../src/domain');
const equipment = { name: 'Lathe', intervalDays: 30, nextServiceDate: '2026-01-01' };

function invalid(input, kind = 'equipment', partial = false) {
  assert.throws(() => validate(input, kind, partial), (error) => error instanceof HttpError && error.status === 400);
}

test('validation normalizes text, defaults optional fields and preserves input', () => {
  const input = { ...equipment, name: '  Lathe  ' };
  assert.deepEqual(validate(input, 'equipment'), { ...equipment, location: '', notes: '' });
  assert.equal(input.name, '  Lathe  ');
  assert.deepEqual(validate({ date: '2024-02-29', description: ' Check ' }, 'service'), {
    date: '2024-02-29', description: 'Check', technician: ''
  });
  assert.deepEqual(validate({ location: '' }, 'equipment', true), { location: '' });
  const first = createRecord(equipment, 'equipment');
  const second = createRecord(equipment, 'equipment');
  assert.notEqual(first.id, second.id);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
});

test('validation rejects malformed objects, protected fields and numeric boundaries', () => {
  for (const input of [null, [], true, 12, 'text', {}]) invalid(input);
  for (const intervalDays of [0, -1, 3651, 1.5, '30', null, NaN, Infinity]) invalid({ ...equipment, intervalDays });
  for (const intervalDays of [1, 3650]) assert.equal(validate({ ...equipment, intervalDays }, 'equipment').intervalDays, intervalDays);
  for (const field of ['id', 'createdAt', 'dueDate', 'status', '__proto__']) invalid({ ...equipment, [field]: 'forged' });
  invalid({}, 'equipment', true);
  invalid({ equipmentId: 'other' }, 'service', true);
});

test('validation enforces text lengths, types, control characters and calendar dates', () => {
  for (const [kind, base, field, limit] of [
    ['equipment', equipment, 'name', 200], ['equipment', equipment, 'location', 200],
    ['equipment', equipment, 'notes', 2000],
    ['service', { date: '2026-01-01', description: 'Check' }, 'description', 2000],
    ['service', { date: '2026-01-01', description: 'Check' }, 'technician', 200]
  ]) {
    assert.equal(validate({ ...base, [field]: 'x'.repeat(limit) }, kind)[field].length, limit);
    for (const value of ['x'.repeat(limit + 1), 1, null, 'bad\u0000text', 'bad\u007ftext']) invalid({ ...base, [field]: value }, kind);
  }
  invalid({ ...equipment, name: ' \n\t ' });
  for (const date of ['2023-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '1899-12-31', '9990-01-01', '2026-01-01T00:00:00Z']) {
    invalid({ ...equipment, nextServiceDate: date });
    invalid({ date, description: 'Check' }, 'service');
  }
  for (const date of ['1900-01-01', '2024-02-29', '9989-12-31']) assert.equal(validate({ ...equipment, nextServiceDate: date }, 'equipment').nextServiceDate, date);
});

test('schedule ignores unrelated history and handles year rollover without mutation', () => {
  const item = { ...equipment, id: 'lathe', intervalDays: 2 };
  const history = [{ equipmentId: 'other', date: '2030-01-01' }, { equipmentId: 'lathe', date: '2025-12-31' }, { equipmentId: 'lathe', date: '2025-01-01' }];
  const original = JSON.stringify({ item, history });
  assert.equal(equipmentView(item, history, '2026-01-02').dueDate, '2026-01-02');
  assert.equal(equipmentView(item, history, '2026-01-02').status, 'due');
  assert.equal(equipmentView(item, [], '2025-12-31').status, 'scheduled');
  assert.equal(equipmentView(item, [], '2026-01-02').status, 'overdue');
  assert.equal(equipmentView(item, []).lastServiceDate, null);
  assert.equal(JSON.stringify({ item, history }), original);
});


test('latest supported service date and maximum interval retain a four-digit due year', () => {
  const item = { ...equipment, id: 'lathe', intervalDays: 3650 };
  const service = validate({ date: '9989-12-31', description: 'Inspection' }, 'service');
  const view = equipmentView(item, [{ ...service, equipmentId: item.id }], '9989-12-31');
  assert.equal(view.dueDate, '9999-12-29');
  assert.equal(view.status, 'scheduled');
  invalid({ date: '9990-12-31', description: 'Inspection' }, 'service');
});
