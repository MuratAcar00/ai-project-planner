'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('../src/app');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.http-test-'));
  const server = createServer({ dataFile: path.join(directory, 'calendar.json') });
  assert.equal(server.listening, false);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip(`Loopback listening unavailable: ${error.code}`);
    return;
  }
  return (route, method = 'GET', body, contentType = 'application/json') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      agent: false, headers: body === undefined ? {} : { 'Content-Type': contentType } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          body: text && res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const equipment = { name: '<img src=x onerror=alert(1)>', intervalDays: 1, nextServiceDate: '2024-02-28' };

test('real HTTP workflow preserves text, scopes history, exports and cascades deletion', async (t) => {
  const request = await fixture(t);
  if (!request) return;
  assert.deepEqual((await request('/api/health')).body, { status: 'ok' });
  const first = await request('/api/equipment', 'POST', equipment);
  assert.equal(first.status, 201);
  const route = first.headers.location;
  const other = await request('/api/equipment', 'POST', { ...equipment, name: 'Other' });
  const service = await request(`${route}/services`, 'POST', { date: '2024-02-29', description: 'Oil\nchanged' });
  assert.equal(service.status, 201);
  const wrongRoute = `${other.headers.location}/services/${service.body.id}`;
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    assert.equal((await request(wrongRoute, method, method === 'PATCH' ? { description: 'wrong' } : undefined)).status, 404);
  }
  assert.equal((await request(service.headers.location)).body.description, 'Oil\nchanged');
  assert.equal((await request(route)).body.dueDate, '2024-03-01');
  assert.equal((await request(route)).body.name, equipment.name);
  const exported = await request('/api/export');
  assert.match(exported.headers['content-type'], /^text\/plain/);
  assert.match(exported.headers['content-disposition'], /attachment/);
  assert.match(exported.text, /Oil changed/);
  assert.equal(exported.headers['x-content-type-options'], 'nosniff');
  const deleted = await request(route, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  assert.equal((await request(service.headers.location)).status, 404);
  assert.equal((await request('/api/equipment')).body.length, 1);
});

test('real HTTP rejects invalid requests and remains available after errors', async (t) => {
  const request = await fixture(t);
  if (!request) return;
  for (const [body, type, status] of [['{bad', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(17000), 'application/json', 413], ['null', 'application/json', 400]]) {
    const response = await request('/api/equipment', 'POST', body, type);
    assert.equal(response.status, status);
    assert.equal(typeof response.body.error, 'string');
  }
  const unsupported = await request('/api/equipment', 'PUT', {});
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.allow, 'GET, POST');
  assert.equal((await request('/unknown')).status, 404);
  assert.deepEqual((await request('/api/equipment')).body, []);
  assert.equal((await request('/api/equipment', 'POST', equipment, 'Application/JSON; charset=utf-8')).status, 201);
  assert.equal((await request('/', 'HEAD')).text, '');
  assert.equal((await request('/')).status, 200);
});
