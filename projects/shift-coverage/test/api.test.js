'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createServer } = require('../src/app');
const { createStore } = require('../src/store');
const { saveRecord } = require('../src/domain');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'state.json');
}
async function dispatch(server, route, method = 'GET', raw, contentType = 'application/json') {
  const request = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
  request.url = route.startsWith('/') ? route : `/api/${route}`;
  request.method = method;
  request.headers = { 'content-type': contentType };
  return new Promise((resolve) => {
    const headers = new Map();
    const response = {
      destroyed: false,
      setHeader(key, value) { headers.set(key.toLowerCase(), value); },
      writeHead(status, values) {
        this.status = status;
        for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
      },
      end(value) {
        resolve({ status: this.status, headers, body: value && headers.get('content-type').includes('application/json') ? JSON.parse(value) : value || '' });
      }
    };
    server.emit('request', request, response);
  });
}
async function client(t, dataFile, options = {}) {
  const server = createServer({ dataFile, ...options });
  assert.equal(server.listening, false);
  return (route, method = 'GET', body) => dispatch(server, route, method, body === undefined ? undefined : JSON.stringify(body));
}
async function setup(call) {
  const event = (await call('events', 'POST', { name: 'Community picnic', location: 'Park' })).body;
  const volunteer = (await call('volunteers', 'POST', { name: 'Alex' })).body;
  const shift = (await call('shifts', 'POST', { eventId: event.id, title: 'Welcome desk', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', capacity: 2 })).body;
  return { event, volunteer, shift };
}

test('CRUD, assignment limits, coverage, summary and restart persistence', async (t) => {
  const dataFile = temporary(t);
  const call = await client(t, dataFile);
  assert.deepEqual((await call('health')).body, { status: 'ok' });
  const { event, volunteer, shift } = await setup(call);
  assert.equal((await call(`events/${event.id}`)).body.name, 'Community picnic');
  assert.equal((await call('coverage')).body[0].uncovered, 2);
  const assignment = await call('assignments', 'POST', { shiftId: shift.id, volunteerId: volunteer.id });
  assert.equal(assignment.status, 201);
  assert.equal((await call('assignments', 'POST', { shiftId: shift.id, volunteerId: volunteer.id })).status, 409);
  const second = (await call('volunteers', 'POST', { name: 'Sam' })).body;
  assert.equal((await call('assignments', 'POST', { shiftId: shift.id, volunteerId: second.id })).status, 201);
  const third = (await call('volunteers', 'POST', { name: 'Jo' })).body;
  assert.equal((await call('assignments', 'POST', { shiftId: shift.id, volunteerId: third.id })).status, 409);
  assert.equal((await call(`shifts/${shift.id}`, 'PATCH', { capacity: 1 })).status, 409);
  assert.equal((await call(`coverage?eventId=${event.id}`)).body[0].covered, true);
  const exported = await call('summary');
  assert.match(exported.body, /2\/2 assigned \| 0 uncovered/);
  assert.match(exported.body, /Alex, Sam/);
  assert.match(exported.headers.get('content-type'), /text\/plain/);
  const restarted = await client(t, dataFile);
  assert.equal((await restarted('assignments')).body.length, 2);
  assert.equal((await call(`volunteers/${volunteer.id}`, 'PUT', { name: '<script>alert(1)</script>' })).status, 200);
  assert.match((await call('summary')).body, /<script>/);
  assert.equal((await call(`assignments/${assignment.body.id}`, 'PATCH', { volunteerId: third.id })).status, 200);
  assert.equal((await call(`assignments/${assignment.body.id}`, 'DELETE')).status, 204);
  assert.equal((await call(`volunteers/${second.id}`, 'DELETE')).status, 204);
  assert.equal((await call('assignments')).body.length, 0);
  assert.equal((await call(`shifts/${shift.id}`, 'PATCH', { title: 'Updated' })).body.title, 'Updated');
  assert.equal((await call(`events/${event.id}`, 'DELETE')).status, 204);
  assert.deepEqual((await call('shifts')).body, []);
  assert.equal((await call(`events/${event.id}`)).status, 404);
});

test('bounded validation, references and HTTP errors', async (t) => {
  const call = await client(t, temporary(t));
  for (const body of [null, [], {}, { name: '' }, { name: 'x'.repeat(201) }, { name: 'hello\nworld' }, { name: 'Valid', extra: true }]) {
    assert.equal((await call('events', 'POST', body)).status, 400);
  }
  assert.equal((await call('events', 'POST', { name: 'x'.repeat(17000) })).status, 413);
  const { shift } = await setup(call);
  for (const body of [{ capacity: 0 }, { capacity: 1.5 }, { capacity: 1001 }, { startsAt: 'bad' }, { endsAt: '2026-02-30T11:00:00Z' }, { endsAt: '2026-01-01T00:00:00Z' }]) {
    assert.equal((await call(`shifts/${shift.id}`, 'PATCH', body)).status, 400);
  }
  assert.equal((await call('assignments', 'POST', { shiftId: shift.id, volunteerId: 'missing' })).status, 404);
  assert.equal((await call('coverage?eventId=missing')).status, 404);
  assert.equal((await call('missing')).status, 404);
  assert.equal((await call('events', 'DELETE')).status, 405);
});

test('storage isolates snapshots, preserves state on failed writes and rejects corruption', (t) => {
  const dataFile = temporary(t);
  const store = createStore(dataFile);
  const event = store.mutate((state) => saveRecord(state, 'events', { name: 'Original' }));
  store.read().events[0].name = 'Changed';
  assert.equal(store.read().events[0].name, 'Original');
  assert.equal(createStore(dataFile).read().events[0].id, event.id);
  fs.unlinkSync(dataFile);
  fs.mkdirSync(dataFile);
  assert.throws(() => store.mutate((state) => saveRecord(state, 'events', { name: 'Failed' })));
  assert.equal(store.read().events.length, 1);
  fs.rmdirSync(dataFile);
  fs.writeFileSync(dataFile, '{broken');
  assert.throws(() => createStore(dataFile), /Unable to load/);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), '{broken');
});

test('malformed JSON, unsupported content type, and sanitized internal errors', async (t) => {
  const server = createServer({ store: { read() { throw new Error('private storage path'); } } });
  assert.equal((await dispatch(server, 'events', 'POST', '{bad')).status, 400);
  assert.equal((await dispatch(server, 'events', 'POST', '{}', 'text/plain')).status, 415);
  const response = await dispatch(server, 'events');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Internal server error' });
});

 test('dashboard assets are served locally and unknown paths stay private', async () => {
  const server = createServer({ store: { read() { throw new Error('Unused'); } } });
  for (const [route, type, fragment] of [['/', 'text/html', 'id="dashboard"'], ['/styles.css', 'text/css', '@media'], ['/app.js', 'text/javascript', 'textContent']]) {
    const response = await dispatch(server, route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok(response.body.toString().includes(fragment));
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.equal((await dispatch(server, route, 'HEAD')).body, '');
  }
  for (const route of ['/src/store.js', '/data/coverage.json', '/constructor', '/missing.js']) {
    assert.equal((await dispatch(server, route)).status, 404);
  }
});
