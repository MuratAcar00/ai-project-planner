'use strict';

const { randomUUID } = require('node:crypto');
const collections = ['events', 'shifts', 'volunteers', 'assignments'];
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => { throw new AppError(status, message); };
function text(value, field, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    fail(`${field} must be ${optional ? 'at most' : 'between 1 and'} 200 characters without control characters`);
  }
  return value.trim();
}
function find(state, collection, id) {
  const record = state[collection].find((item) => item.id === id);
  if (!record) fail(`${collection} record not found`, 404);
  return record;
}
function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 35 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${field} must be an ISO timestamp with timezone`);
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail(`${field} has an invalid date`);
  return new Date(value).toISOString();
}
function saveRecord(state, collection, body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Expected a JSON object');
  const old = id ? find(state, collection, id) : null;
  const fields = {
    events: ['name', 'location'], volunteers: ['name'],
    shifts: ['eventId', 'title', 'startsAt', 'endsAt', 'capacity'],
    assignments: ['shiftId', 'volunteerId']
  }[collection];
  if (Object.keys(body).some((key) => !fields.includes(key))) fail('Unknown field');
  const input = { ...old, ...body };
  const record = { id: id || randomUUID() };
  if (collection === 'events' || collection === 'volunteers') record.name = text(input.name, 'name');
  if (collection === 'events') record.location = text(input.location, 'location', true);
  if (collection === 'shifts') {
    record.eventId = text(input.eventId, 'eventId');
    find(state, 'events', record.eventId);
    record.title = text(input.title, 'title');
    record.startsAt = timestamp(input.startsAt, 'startsAt');
    record.endsAt = timestamp(input.endsAt, 'endsAt');
    if (record.endsAt <= record.startsAt) fail('endsAt must be after startsAt');
    if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 1000) fail('capacity must be an integer from 1 to 1000');
    record.capacity = input.capacity;
    if (state.assignments.filter((item) => item.shiftId === id).length > record.capacity) fail('Capacity cannot be below current assignments', 409);
  }
  if (collection === 'assignments') {
    record.shiftId = text(input.shiftId, 'shiftId');
    record.volunteerId = text(input.volunteerId, 'volunteerId');
    const shift = find(state, 'shifts', record.shiftId);
    find(state, 'volunteers', record.volunteerId);
    const assigned = state.assignments.filter((item) => item.id !== id && item.shiftId === record.shiftId);
    if (assigned.some((item) => item.volunteerId === record.volunteerId)) fail('Volunteer is already assigned to this shift', 409);
    if (assigned.length >= shift.capacity) fail('Shift is full', 409);
  }
  if (old) state[collection][state[collection].indexOf(old)] = record;
  else {
    if (state[collection].length >= 10000) fail('Collection limit reached', 409);
    state[collection].push(record);
  }
  return record;
}
function removeRecord(state, collection, id) {
  find(state, collection, id);
  state[collection] = state[collection].filter((item) => item.id !== id);
  if (collection === 'events') state.shifts = state.shifts.filter((item) => item.eventId !== id);
  state.assignments = state.assignments.filter((item) => state.shifts.some((shift) => shift.id === item.shiftId) && state.volunteers.some((volunteer) => volunteer.id === item.volunteerId));
}
function coverage(state, eventId) {
  if (eventId) find(state, 'events', eventId);
  return state.shifts.filter((shift) => !eventId || shift.eventId === eventId).map((shift) => {
    const assigned = state.assignments.filter((item) => item.shiftId === shift.id).length;
    return { ...shift, assigned, uncovered: shift.capacity - assigned, covered: assigned === shift.capacity };
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
function summary(state, eventId) {
  const lines = ['Shift Coverage'];
  for (const shift of coverage(state, eventId)) {
    const event = find(state, 'events', shift.eventId);
    const names = state.assignments.filter((item) => item.shiftId === shift.id).map((item) => find(state, 'volunteers', item.volunteerId).name);
    lines.push(`${event.name} / ${shift.title} | ${shift.startsAt} - ${shift.endsAt} | ${shift.assigned}/${shift.capacity} assigned | ${shift.uncovered} uncovered | Volunteers: ${names.join(', ') || 'None'}`);
  }
  if (lines.length === 1) lines.push('No shifts defined.');
  return `${lines.join('\n')}\n`;
}
module.exports = { AppError, collections, saveRecord, removeRecord, find, coverage, summary };
