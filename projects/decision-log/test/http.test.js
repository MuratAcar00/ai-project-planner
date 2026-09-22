'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('../src/app');

async function fixture(t, transport) {
  const directory = await fs.mkdtemp(path.join(__dirname, '..', '.test-http-'));
  const dataFile = path.join(directory, 'decisions.json');
  const server = createServer({ dataFile });
  assert.equal(server.listening, false);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  if (transport === 'real HTTP') try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip(`Loopback sockets unavailable: ${error.code}; handler tests remain active`);
    return null;
  }
  const raw = (route, method = 'GET', chunks = [], headers = {}) => new Promise((resolve, reject) => {
    if (transport === 'handler') {
      const request = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
      Object.assign(request, { url: route, method, headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) });
      server.emit('request', request, {
        destroyed: false,
        writeHead(status, values) {
          this.status = status;
          this.headers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
        },
        end(body) { resolve({ status: this.status, headers: this.headers, text: body?.toString() || '' }); }
      });
      return;
    }
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method, headers, agent: false }, response => {
      const buffers = [];
      response.on('data', chunk => buffers.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(buffers).toString('utf8') }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTP test timed out')));
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
  const call = (route, method = 'GET', data) => raw(route, method,
    data === undefined ? [] : [JSON.stringify(data)], data === undefined ? {} : { 'Content-Type': 'application/json' });
  return { raw, call, dataFile };
}

for (const transport of ['handler', 'real HTTP']) {
test(`${transport}: decision lifecycle, combined filters and export match persisted state`, async t => {
  const fixtureData = await fixture(t, transport);
  if (!fixtureData) return;
  const { call, dataFile } = fixtureData;
  assert.deepEqual(JSON.parse((await call('/api/health')).text), { status: 'ok' });
  await assert.rejects(fs.stat(dataFile), { code: 'ENOENT' });
  const sample = { title: ' Search choice ', decision: 'Use local JSON', context: 'Small team', alternatives: ['Hosted DB'], tags: ['Storage'], reviewDate: '2026-10-01' };
  const created = await call('/api/decisions', 'POST', sample);
  assert.equal(created.status, 201);
  const record = JSON.parse(created.text);
  assert.equal(record.title, 'Search choice');
  const route = created.headers.location;
  assert.equal(route, `/api/decisions/${record.id}`);
  assert.deepEqual(JSON.parse((await call(route)).text), record);
  await call('/api/decisions', 'POST', { title: 'Undated', decision: 'Other', tags: ['Storage'] });
  for (const q of ['search', 'LOCAL', 'small', 'hosted', 'storage']) {
    const response = await call(`/api/decisions?q=${q}&tag=STORAGE&reviewBefore=2026-10-01`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), [record]);
  }
  assert.deepEqual(JSON.parse((await call('/api/decisions?reviewBefore=2026-09-30')).text), []);
  assert.deepEqual(JSON.parse((await call('/api/decisions?tag=stor')).text), []);
  const patched = await call(route, 'PATCH', { title: '<img src=x onerror=alert(1)>', reviewDate: null });
  assert.equal(patched.status, 200);
  assert.equal(JSON.parse(patched.text).createdAt, record.createdAt);
  assert.equal(JSON.parse(patched.text).context, sample.context);
  const exported = await call('/api/decisions/export');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment; filename="decisions.json"/);
  assert.match(exported.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(exported.text), JSON.parse(await fs.readFile(dataFile, 'utf8')));
  assert.deepEqual(JSON.parse((await call('/api/decisions/export?q=Undated')).text).map(item => item.title), ['Undated']);
  const replaced = await call(route, 'PUT', { title: 'Replacement', decision: 'New' });
  assert.equal(replaced.status, 200);
  assert.equal(JSON.parse(replaced.text).context, '');
  assert.deepEqual(JSON.parse(replaced.text).tags, []);
  const removed = await call(route, 'DELETE');
  assert.equal(removed.status, 204);
  assert.equal(removed.text, '');
  for (const [method, data] of [['GET'], ['DELETE'], ['PATCH', { title: 'Gone' }], ['PUT', sample]]) {
    assert.equal((await call(route, method, data)).status, 404);
  }
});

test(`${transport}: malformed, oversized and unsupported requests leave storage intact`, async t => {
  const fixtureData = await fixture(t, transport);
  if (!fixtureData) return;
  const { raw, call, dataFile } = fixtureData;
  const created = await call('/api/decisions', 'POST', { title: 'Original', decision: 'Keep' });
  const route = created.headers.location;
  const before = await fs.readFile(dataFile, 'utf8');
  for (const [body, contentType, status] of [['{', 'application/json', 400], ['', 'application/json', 400],
    ['null', 'application/json', 400], ['[]', 'application/json', 400], ['{}', 'text/plain', 415],
    [JSON.stringify({ title: 'x'.repeat(140000) }), 'application/json', 413]]) {
    const response = await raw(route, 'PATCH', [body.slice(0, 10), body.slice(10)], { 'Content-Type': contentType });
    assert.equal(response.status, status);
    assert.equal(typeof JSON.parse(response.text).error, 'string');
  }
  assert.equal((await raw(route, 'PATCH', ['{}'])).status, 415);
  for (const query of ['unknown=1', 'q=a&q=b', 'tag=a&tag=b', 'reviewBefore=', 'reviewBefore=2026-02-29', `q=${'x'.repeat(201)}`]) {
    assert.equal((await call(`/api/decisions?${query}`)).status, 400);
    assert.equal((await call(`/api/decisions/export?${query}`)).status, 400);
  }
  assert.equal((await call(`/${'x'.repeat(2048)}`)).status, 400);
  for (const [url, method, allow] of [['/api/decisions', 'DELETE', 'GET, POST'], ['/api/decisions/export', 'POST', 'GET'], [route, 'POST', 'GET, PUT, PATCH, DELETE']]) {
    const response = await call(url, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, allow);
  }
  assert.equal(await fs.readFile(dataFile, 'utf8'), before);
  assert.equal((await call('/api/health')).status, 200);
  await fs.writeFile(dataFile, '{broken');
  for (const [url, method, data] of [['/api/decisions', 'GET'], ['/api/decisions/export', 'GET'], [route, 'GET'], [route, 'DELETE'], ['/api/decisions', 'POST', { title: 'x', decision: 'y' }]]) {
    const response = await call(url, method, data);
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.text), { error: 'Internal server error' });
  }
  assert.equal(await fs.readFile(dataFile, 'utf8'), '{broken');
});
}
