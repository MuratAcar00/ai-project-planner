'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDecision, validateDate, ValidationError } = require('../src/validation');
const sample = { title: 'Choice', decision: 'Proceed' };

test('every field accepts its boundary and rejects invalid types and excess length', () => {
  for (const [field, limit] of [['title', 200], ['decision', 10000], ['context', 10000]]) {
    assert.equal(validateDecision({ ...sample, [field]: 'x'.repeat(limit) })[field].length, limit);
    for (const value of [null, 1, false, [], {}, 'x'.repeat(limit + 1)]) {
      assert.throws(() => validateDecision({ ...sample, [field]: value }), ValidationError);
    }
  }
  for (const [field, count, length] of [['tags', 20, 50], ['alternatives', 30, 2000]]) {
    const values = Array.from({ length: count }, (_, i) => `${i}`.padEnd(length, 'x'));
    assert.deepEqual(validateDecision({ ...sample, [field]: values })[field], values);
    for (const value of [null, 'text', {}, [...values, 'extra'], ['x'.repeat(length + 1)], [' '], [1]]) {
      assert.throws(() => validateDecision({ ...sample, [field]: value }), ValidationError);
    }
    assert.deepEqual(validateDecision({ ...sample, [field]: [' a ', 'a', 'b'] })[field], ['a', 'b']);
  }
});

test('partial updates preserve omission and reject server-managed and prototype keys', () => {
  assert.deepEqual(validateDecision({ reviewDate: null }, true), { reviewDate: null });
  for (const value of [null, [], true, 'text', {}, { title: ' ' }, { decision: '' },
    { id: 'override' }, { createdAt: 'override' }, { updatedAt: 'override' },
    JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateDecision(value, true), ValidationError);
  }
});

test('calendar validation rejects rollover and non-date formats', () => {
  for (const value of ['2024-02-29', '2000-02-29', '2026-12-31']) assert.equal(validateDate(value), value);
  assert.equal(validateDate(null, true), null);
  for (const value of [null, '', 20260101, '1900-02-29', '2026-04-31', '2026-00-01',
    '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z', ' 2026-01-01']) {
    assert.throws(() => validateDate(value), ValidationError);
  }
});
