'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createServer } = require('../src/app');
const { createStore } = require('../src/store');
const { validateDocument, filterDocuments } = require('../src/domain');

const sample = { title: 'Office insurance', owner: 'Alex', expiryDate: '2027-01-31' };

async function storage(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.tmp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'documents.json');
}

test('document validation accepts metadata and rejects invalid or unbounded values', () => {
  assert.deepEqual(validateDocument(sample), { ...sample, category: '', notes: '' });
  assert.equal(validateDocument({ ...sample, title: '  Policy  ' }).title, 'Policy');
  assert.equal(validateDocument({ ...sample, expiryDate: '2028-02-29' }).expiryDate, '2028-02-29');
  for (const input of [null, [], {}, { ...sample, owner: '' }, { ...sample, title: 'x'.repeat(201) },
    { ...sample, expiryDate: '2027-02-29' }, { ...sample, expiryDate: '2027-04-31' },
    { ...sample, upload: 'file' }, { ...sample, notes: 3 }, { ...sample, title: 'bad\u0000' }]) {
    assert.throws(() => validateDocument(input), { status: 400 });
  }
  assert.deepEqual(validateDocument({ owner: 'Pat' }, true), { owner: 'Pat' });
});

test('expiry filters include boundaries and reject ambiguous filters', () => {
  const documents = ['2027-01-01', '2027-01-31', '2027-02-01'].map((expiryDate, id) => ({ ...sample, expiryDate, id: String(id) }));
  assert.equal(filterDocuments(documents, new URLSearchParams('withinDays=30&owner=alex'), '2027-01-01').length, 2);
  assert.equal(filterDocuments(documents, new URLSearchParams('to=2027-01-01')).length, 1);
  for (const query of ['withinDays=-1', 'withinDays=3651', 'from=bad', 'from=2027-02-01&to=2027-01-01',
    'withinDays=3&from=2027-01-01', 'owner=', 'owner=Alex&owner=Pat', 'unknown=yes']) {
    assert.throws(() => filterDocuments(documents, new URLSearchParams(query)), { status: 400 });
  }
});

test('store persists CRUD across instances and serializes concurrent writes', async t => {
  const file = await storage(t);
  const store = createStore(file);
  assert.deepEqual(await store.list(), []);
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({ ...sample, title: `Document ${index}` })));
  assert.equal((await createStore(file).list()).length, 12);
  const updated = await store.update(created[0].id, { owner: 'Pat' });
  assert.equal(updated.title, 'Document 0');
  assert.equal(updated.createdAt, created[0].createdAt);
  assert.equal((await createStore(file).list())[0].owner, 'Pat');
  await assert.rejects(store.update('missing', { owner: 'Pat' }), { status: 404 });
  await store.remove(created[0].id);
  assert.equal((await createStore(file).list()).length, 11);
  await assert.rejects(store.remove(created[0].id), { status: 404 });
  await fs.writeFile(file, 'corrupted');
  await assert.rejects(store.list());
  await assert.rejects(store.create(sample));
  assert.equal(await fs.readFile(file, 'utf8'), 'corrupted');
});

async function api(t) {
  const dataFile = await storage(t);
  const server = createServer({ dataFile });
  assert.equal(server.listening, false);
  // Exercise the actual server request listener without opening sandbox-blocked sockets.
  const rawRequest = (route, options = {}) => new Promise(resolve => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    req.url = route;
    req.method = options.method || 'GET';
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const headers = new Headers();
    let status = 200;
    const res = {
      setHeader(key, value) { headers.set(key, value); },
      writeHead(code, values) {
        status = code;
        for (const [key, value] of Object.entries(values)) headers.set(key, value);
      },
      end(body) { resolve(new Response(status === 204 ? null : body, { status, headers })); }
    };
    server.emit('request', req, res);
  });
  const request = (route, method = 'GET', body) => rawRequest(route, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { request, rawRequest, dataFile };
}

test('HTTP CRUD, renewal filtering, and safe text export', async t => {
  const { request } = await api(t);
  assert.deepEqual(await (await request('/api/health')).json(), { status: 'ok' });
  const response = await request('/api/documents', 'POST', { ...sample, title: '<script>alert(1)</script>' });
  assert.equal(response.status, 201);
  const { document } = await response.json();
  const route = `/api/documents/${document.id}`;
  assert.equal(response.headers.get('location'), route);
  assert.deepEqual((await (await request(route)).json()).document, document);
  assert.equal((await (await request('/api/documents?owner=Alex&from=2027-01-01&to=2027-01-31')).json()).documents.length, 1);
  assert.equal((await (await request('/api/documents?owner=Pat')).json()).documents.length, 0);
  assert.equal((await (await request(route, 'PATCH', { owner: 'Pat' })).json()).document.owner, 'Pat');
  const exported = await request('/api/export?owner=Pat');
  assert.match(exported.headers.get('content-type'), /^text\/plain/);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await exported.text(), /Owner: Pat/);
  assert.equal((await request(route, 'PUT', sample)).status, 200);
  assert.equal((await request(route, 'DELETE')).status, 204);
  assert.equal((await request(route)).status, 404);
  assert.equal((await request(route, 'PATCH', { owner: 'Pat' })).status, 404);
});

test('HTTP errors are bounded and do not disclose storage details', async t => {
  const { request, rawRequest, dataFile } = await api(t);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/api/documents', 'POST', {})).status, 400);
  assert.equal((await request('/api/documents?withinDays=bad')).status, 400);
  assert.equal((await request('/api/documents', 'POST', { ...sample, notes: 'x'.repeat(17000) })).status, 413);
  assert.equal((await rawRequest('/api/documents', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await rawRequest('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const unsupported = await request('/api/documents', 'DELETE');
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET, POST');
  await fs.writeFile(dataFile, '{}');
  const failed = await request('/api/documents');
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Internal server error.' });
});

test('dashboard serves only local allowlisted assets with safe content types', async t => {
  const { request } = await api(t);
  for (const [route, type, marker] of [
    ['/', 'text/html', 'Document Watch'],
    ['/index.html', 'text/html', 'Register document'],
    ['/styles.css', 'text/css', '@media'],
    ['/app.js', 'text/javascript', 'textContent']
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.ok((await response.text()).includes(marker));
  }
  assert.equal(await (await request('/', 'HEAD')).text(), '');
  for (const route of ['/src/store.js', '/data/documents.json', '/public/../src/app.js', '/constructor']) {
    assert.equal((await request(route)).status, 404);
  }
});

test('register, renew, filter and export metadata workflow', async t => {
  const { request } = await api(t);
  const today = new Date().toISOString().slice(0, 10);
  const { document } = await (await request('/api/documents', 'POST', {
    title: 'Business license', owner: 'Office team', expiryDate: today, category: 'Licenses', notes: 'Contact issuer'
  })).json();
  const filter = '/api/documents?withinDays=30&owner=Office%20team';
  assert.equal((await (await request(filter)).json()).documents.length, 1);
  const summary = await (await request('/api/export?withinDays=30&owner=Office%20team')).text();
  assert.match(summary, /Business license/);
  assert.match(summary, /Owner: Office team/);
  assert.equal((await request(`/api/documents/${document.id}`, 'PUT', {
    title: document.title, owner: 'New owner', expiryDate: '2099-01-01', category: document.category, notes: document.notes
  })).status, 200);
  assert.equal((await (await request(filter)).json()).documents.length, 0);
  assert.match(await (await request('/api/export?owner=New%20owner')).text(), /2099-01-01/);
});
