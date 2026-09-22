'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../src/app');
const { createStore } = require('../src/store');
const { validateDocument, filterDocuments } = require('../src/domain');

const sample = { title: 'License', owner: 'Office', expiryDate: '2028-02-29' };
async function storage(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.tmp-critical-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'documents.json');
}

test('validation enforces each field boundary and replacement requirements', () => {
  for (const [field, limit] of Object.entries({ title: 200, owner: 120, category: 100, notes: 2000 })) {
    assert.equal(validateDocument({ ...sample, [field]: 'x'.repeat(limit) })[field].length, limit);
    for (const value of ['x'.repeat(limit + 1), null, 1, {}, [], 'bad\u007f']) {
      assert.throws(() => validateDocument({ ...sample, [field]: value }), { status: 400 });
    }
  }
  for (const field of ['title', 'owner', 'expiryDate']) {
    const input = { ...sample };
    delete input[field];
    assert.throws(() => validateDocument(input), { status: 400 });
    assert.throws(() => validateDocument({ [field]: ' \t ' }, true), { status: 400 });
  }
  for (const expiryDate of ['2028-2-29', '2028-13-01', '2028-00-01', '2028-02-30', '2028-02-29T00:00:00Z']) {
    assert.throws(() => validateDocument({ ...sample, expiryDate }), { status: 400 });
  }
  assert.deepEqual(validateDocument({ notes: '' }, true), { notes: '' });
  assert.throws(() => validateDocument({ id: 'injected' }, true), { status: 400 });
});

test('renewal filters sort without mutation and handle leap-day and zero-day windows', () => {
  const documents = [
    { ...sample, id: 'z', expiryDate: '2028-03-01' },
    { ...sample, id: 'b' }, { ...sample, id: 'a' },
    { ...sample, id: 'old', expiryDate: '2028-02-28' }
  ];
  const original = structuredClone(documents);
  const select = query => filterDocuments(documents, new URLSearchParams(query), '2028-02-29').map(doc => doc.id);
  assert.deepEqual(select('withinDays=0'), ['a', 'b']);
  assert.deepEqual(select('withinDays=1&owner=%20OFFICE%20'), ['a', 'b', 'z']);
  assert.deepEqual(select('from=2028-03-01'), ['z']);
  assert.deepEqual(select('owner=Missing'), []);
  assert.deepEqual(documents, original);
  for (const query of ['to=', 'withinDays=', 'withinDays=1.5', 'withinDays=1&to=2028-03-01',
    'from=2028-02-29&from=2028-02-29', 'withinDays=0&withinDays=1', `owner=${'x'.repeat(121)}`]) {
    assert.throws(() => select(query), { status: 400 });
  }
});

test('failed mutations preserve bytes, queue recovers, and replacement clears optional metadata', async t => {
  const file = await storage(t);
  const store = createStore(file);
  const doc = await store.create({ ...sample, notes: 'Old note', category: 'Legal' });
  const before = await fs.readFile(file, 'utf8');
  assert.throws(() => store.update(doc.id, { owner: '' }), { status: 400 });
  await assert.rejects(store.remove('missing'), { status: 404 });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const updated = await store.update(doc.id, sample, false);
  assert.equal(updated.notes, '');
  assert.equal(updated.category, '');
  assert.equal(updated.createdAt, doc.createdAt);
  assert.deepEqual(await createStore(file).list(), [updated]);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['documents.json']);
});

test('corrupt storage is never overwritten and can recover after repair', async t => {
  const file = await storage(t);
  const store = createStore(file);
  const doc = await store.create(sample);
  for (const content of ['{', '{}', '[null]', JSON.stringify([doc, doc]), JSON.stringify([{ ...doc, expiryDate: 'invalid' }])]) {
    await fs.writeFile(file, content);
    await assert.rejects(store.list());
    await assert.rejects(store.create(sample));
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.writeFile(file, '[]');
  await store.create(sample);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['documents.json']);
});

test('real HTTP workflow and transport errors use isolated storage', async t => {
  const dataFile = await storage(t);
  const server = createServer({ dataFile });
  assert.equal(server.listening, false);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip(`Loopback sockets unavailable: ${error.code}; handler tests remain active`);
    return;
  }
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const request = (route, method = 'GET', body, contentType = 'application/json') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'Content-Type': contentType }, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP test timed out')));
    req.end(body);
  });
  assert.equal((await request('/api/health')).text, '{"status":"ok"}');
  const created = await request('/api/documents', 'POST', JSON.stringify({ ...sample, title: 'License\n<script>x</script>', owner: 'Office\tteam' }));
  assert.equal(created.status, 201);
  const route = created.headers.location;
  assert.equal((await request(route)).status, 200);
  const summary = await request('/api/export?owner=Office%09team');
  assert.equal(summary.status, 200);
  assert.match(summary.headers['content-type'], /^text\/plain/);
  assert.match(summary.text, /License <script>x<\/script> \| Owner: Office team/);
  assert.equal((await request(route, 'PATCH', '{"owner":"Pat"}')).status, 200);
  assert.equal(JSON.parse((await request('/api/documents?owner=Pat')).text).documents.length, 1);
  for (const [body, type, status] of [['{', 'application/json', 400], ['', 'application/json', 400],
    ['null', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(17000), 'application/json', 413]]) {
    assert.equal((await request('/api/documents', 'POST', body, type)).status, status);
  }
  assert.equal((await request(`/api/documents?owner=${'x'.repeat(2050)}`)).status, 414);
  const method = await request(route, 'POST', '{}');
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'GET, PATCH, PUT, DELETE');
  assert.equal((await request('/', 'HEAD')).text, '');
  const deleted = await request(route, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.equal((await request(route)).status, 404);
  await fs.writeFile(dataFile, 'broken');
  const failed = await request('/api/export');
  assert.equal(failed.status, 500);
  assert.equal(failed.text, '{"error":"Internal server error."}');
  assert.equal(await fs.readFile(dataFile, 'utf8'), 'broken');
  assert.equal((await request('/api/health')).status, 200);
});
