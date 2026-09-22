'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { saveRecord } = require('../../src/domain');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '../.isolated-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'state.json');
}
function fixture() {
  const state = { events: [], volunteers: [], shifts: [], assignments: [] };
  const event = saveRecord(state, 'events', { name: 'Picnic' });
  const volunteer = saveRecord(state, 'volunteers', { name: 'Alex' });
  const shift = saveRecord(state, 'shifts', { eventId: event.id, title: 'Welcome', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', capacity: 1 });
  return { state, event, volunteer, shift };
}
module.exports = { temporary, fixture };
