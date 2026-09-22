'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const path = require('node:path');
const { createServer } = require('../src/app');
const { DecisionStore } = require('../src/store');
const { validateDecision } = require('../src/validation');

const sample = { title: 'Use local storage', decision: 'Keep JSON on disk', context: 'Small team', alternatives: ['Hosted database'], tags: ['Architecture'], reviewDate: '2026-10-01' };

async function fixture(t, serve = false) {
  const directory = await fs.mkdtemp(path.join(__dirname, '..', '.test-data-'));
  const dataFile = path.join(directory, 'decisions.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DecisionStore(dataFile);
  if (!serve) return { store, dataFile };
  const server = createServer({ dataFile });
  assert.equal(server.listening, false);
  const raw = (route, options = {}) => new Promise(resolve => {
    const request = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    request.url = route;
    request.method = options.method || 'GET';
    request.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const response = {
      destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(value) {
        resolve({
          status: this.status,
          headers: { get: name => Object.entries(this.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || null },
          json: async () => JSON.parse(value)
        });
      }
    };
    server.emit('request', request, response);
  });
  const call = (route, method = 'GET', data) => raw(route, {
    method,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { store, dataFile, raw, call };
}

test('domain validates bounded fields and calendar dates', () => {
  assert.deepEqual(validateDecision({ title: ' x ', decision: ' y ' }), {
    title: 'x', decision: 'y', context: '', alternatives: [], tags: [], reviewDate: null
  });
  for (const value of [null, [], {}, { ...sample, title: ' ' }, { ...sample, title: 'x'.repeat(201) },
    { ...sample, decision: 1 }, { ...sample, context: 'x'.repeat(10001) },
    { ...sample, tags: Array(21).fill('x') }, { ...sample, alternatives: [null] },
    { ...sample, reviewDate: '2026-02-29' }, { ...sample, reviewDate: '2026-13-01' },
    { ...sample, id: 'override' }]) assert.throws(() => validateDecision(value));
  assert.throws(() => validateDecision({}, true));
  assert.equal(validateDecision({ reviewDate: '2028-02-29' }, true).reviewDate, '2028-02-29');
});

test('store persists changes across instances and serializes concurrent writes', async t => {
  const { store, dataFile } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  const records = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create({ ...sample, title: `Decision ${i}` })));
  const reopened = new DecisionStore(dataFile);
  assert.equal((await reopened.list()).length, 12);
  await reopened.update(records[0].id, { title: 'Changed', reviewDate: null });
  assert.equal((await store.list())[0].title, 'Changed');
  await reopened.delete(records[1].id);
  assert.equal((await store.list()).length, 11);
  await assert.rejects(reopened.delete(records[1].id), { status: 404 });
  await reopened.create(sample);
  assert.equal((await store.list()).length, 12);
});

test('corrupted persistence is not overwritten', async t => {
  const { store, dataFile } = await fixture(t);
  for (const raw of ['broken JSON', '{}', '[{"id":"bad"}]']) {
    await fs.writeFile(dataFile, raw);
    await assert.rejects(store.list());
    await assert.rejects(store.create(sample));
    assert.equal(await fs.readFile(dataFile, 'utf8'), raw);
  }
});

test('HTTP CRUD, search, reviews and JSON export', async t => {
  const { call } = await fixture(t, true);
  assert.deepEqual(await (await call('/api/health')).json(), { status: 'ok' });
  const created = await call('/api/decisions', 'POST', sample);
  assert.equal(created.status, 201);
  const record = await created.json();
  const route = `/api/decisions/${record.id}`;
  assert.equal(created.headers.get('location'), route);
  assert.deepEqual(await (await call(route)).json(), record);
  for (const query of ['q=HOSTED', 'tag=architecture', 'reviewBefore=2026-10-01']) {
    assert.equal((await (await call(`/api/decisions?${query}`)).json()).length, 1);
  }
  assert.deepEqual(await (await call('/api/decisions?reviewBefore=2026-09-30')).json(), []);
  assert.deepEqual(await (await call('/api/decisions?q=unmatched')).json(), []);
  const updated = await call(route, 'PATCH', { title: '<script>text only</script>', reviewDate: null });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).createdAt, record.createdAt);
  const exported = await call('/api/decisions/export');
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.match(exported.headers.get('content-type'), /application\/json/);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await exported.json())[0].title, '<script>text only</script>');
  const replaced = await call(route, 'PUT', { title: 'Replacement', decision: 'New choice' });
  assert.equal(replaced.status, 200);
  assert.deepEqual((await replaced.json()).tags, []);
  assert.equal((await call(route, 'DELETE')).status, 204);
  assert.equal((await call(route)).status, 404);
  assert.equal((await call(route, 'PATCH', { title: 'Missing' })).status, 404);
  assert.equal((await call(route, 'DELETE')).status, 404);
});

test('HTTP rejects invalid requests and masks storage errors', async t => {
  const { call, raw, dataFile } = await fixture(t, true);
  assert.equal((await call('/api/decisions', 'POST', {})).status, 400);
  assert.equal((await call('/api/decisions?reviewBefore=nope')).status, 400);
  assert.equal((await call('/api/decisions?unknown=1')).status, 400);
  assert.equal((await call('/api/decisions?q=a&q=b')).status, 400);
  assert.equal((await call('/missing')).status, 404);
  assert.equal((await call('/api/decisions', 'DELETE')).status, 405);
  assert.equal((await raw('/api/decisions', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await raw('/api/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await call('/api/decisions', 'POST', { ...sample, context: 'a'.repeat(140000) })).status, 413);
  await fs.writeFile(dataFile, '{broken');
  const failed = await call('/api/decisions');
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Internal server error' });
});
