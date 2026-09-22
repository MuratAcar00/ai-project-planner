'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createServer } = require('../src/app');
const { Store } = require('../src/store');
const { equipmentView } = require('../src/domain');

const equipment = { name: 'Lathe', location: 'Workshop', intervalDays: 30, nextServiceDate: '2026-01-01' };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.test-data-'));
  const dataFile = path.join(directory, 'calendar.json');
  const server = createServer({ dataFile });
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = (route, method = 'GET', body, raw = false) => dispatch(server, route, method, body, raw);
  return { request, dataFile };
}

// Exercise the actual HTTP request listener without opening a network socket.
function dispatch(server, route, method = 'GET', body, raw = false) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(raw ? body : JSON.stringify(body))]);
  req.url = route;
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const res = {
      setHeader(key, value) { headers.set(key.toLowerCase(), value); },
      writeHead(status, values) {
        this.status = status;
        for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
      },
      end(value) {
        const text = value || '';
        resolve({ status: this.status, headers, body: text && headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text });
      }
    };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('equipment, service history, scheduling, export and deletion workflow', async (t) => {
  const { request, dataFile } = await fixture(t);
  assert.deepEqual((await request('/api/health')).body, { status: 'ok' });
  assert.deepEqual((await request('/api/equipment')).body, []);
  const created = await request('/api/equipment', 'POST', equipment);
  assert.equal(created.status, 201);
  const route = created.headers.get('location');
  assert.equal(created.body.dueDate, equipment.nextServiceDate);
  assert.equal((await request(route, 'PATCH', { name: 'Main lathe' })).body.name, 'Main lathe');
  const service = await request(`${route}/services`, 'POST', { date: '2026-02-01', description: 'Oil changed' });
  assert.equal(service.status, 201);
  assert.equal((await request(route)).body.dueDate, '2026-03-03');
  const serviceRoute = service.headers.get('location');
  assert.equal((await request(serviceRoute)).body.description, 'Oil changed');
  assert.equal((await request(`${route}/services`)).body.length, 1);
  await request(serviceRoute, 'PATCH', { date: '2026-02-02' });
  assert.equal((await request(route)).body.dueDate, '2026-03-04');
  await request(route, 'PATCH', { intervalDays: 10 });
  assert.equal((await request(route)).body.dueDate, '2026-02-12');
  const persisted = await new Store(dataFile).read();
  assert.equal(persisted.equipment[0].name, 'Main lathe');
  assert.equal(persisted.services[0].date, '2026-02-02');
  const exported = await request('/api/export');
  assert.equal(exported.status, 200);
  assert.match(exported.body, /Main lathe.*Every 10 days/);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal((await request(serviceRoute, 'DELETE')).status, 204);
  assert.equal((await request(route)).body.dueDate, equipment.nextServiceDate);
  await request(`${route}/services`, 'POST', { date: '2026-02-01', description: 'Inspection' });
  assert.equal((await request(route, 'DELETE')).status, 204);
  assert.equal((await request(route)).status, 404);
  assert.deepEqual((await new Store(dataFile).read()).services, []);
});

test('bounded input, malformed bodies, missing records and unsupported methods', async (t) => {
  const { request } = await fixture(t);
  for (const body of [null, [], {}, { ...equipment, name: '' }, { ...equipment, name: 'x'.repeat(201) }, { ...equipment, intervalDays: 0 }, { ...equipment, intervalDays: 1.5 }, { ...equipment, nextServiceDate: '2026-02-30' }, { ...equipment, unknown: true }]) {
    assert.equal((await request('/api/equipment', 'POST', body)).status, 400);
  }
  assert.equal((await request('/api/equipment', 'POST', '{bad', true)).status, 400);
  assert.equal((await request('/api/equipment', 'POST', 'x'.repeat(17000), true)).status, 413);
  assert.equal((await request('/api/equipment', 'POST')).status, 415);
  assert.equal((await request('/api/equipment/missing')).status, 404);
  assert.equal((await request('/api/equipment/missing/services', 'POST', { date: '2026-01-01', description: 'Check' })).status, 404);
  assert.equal((await request('/api/equipment', 'PUT', equipment)).status, 405);
  assert.equal((await request('/unknown')).status, 404);
  const created = await request('/api/equipment', 'POST', equipment);
  const route = created.headers.get('location');
  assert.equal((await request(route, 'PATCH', {})).status, 400);
  assert.equal((await request(`${route}/services`, 'POST', { date: 'bad', description: 'Check' })).status, 400);
  assert.equal((await request(route)).body.name, equipment.name);
});

test('concurrent writes persist and a newly created server loads saved data', async (t) => {
  const { request, dataFile } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request('/api/equipment', 'POST', { ...equipment, name: `Machine ${index}` })));
  assert.ok(results.every((result) => result.status === 201));
  assert.equal((await new Store(dataFile).read()).equipment.length, 12);
  const restarted = createServer({ dataFile });
  const response = await dispatch(restarted, '/api/equipment');
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 12);
});

test('corrupt persistence returns a safe error and is not overwritten', async (t) => {
  const { request, dataFile } = await fixture(t);
  await fs.writeFile(dataFile, 'broken data');
  const response = await request('/api/equipment');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Internal server error' });
  assert.equal((await request('/api/equipment', 'POST', equipment)).status, 500);
  assert.equal(await fs.readFile(dataFile, 'utf8'), 'broken data');
});

test('due dates use latest service regardless of insertion order and handle leap years', () => {
  const item = { ...equipment, id: 'machine', intervalDays: 1 };
  const history = [{ equipmentId: 'machine', date: '2024-02-28' }, { equipmentId: 'machine', date: '2024-02-01' }];
  assert.equal(equipmentView(item, history, '2024-02-29').status, 'due');
  assert.equal(equipmentView(item, history, '2024-03-01').status, 'overdue');
  assert.equal(equipmentView(item, history, '2024-02-28').status, 'scheduled');
});

test('dashboard serves only local allowlisted assets with restrictive browser policy', async (t) => {
  const { request } = await fixture(t);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.body, /id="equipment-form"/);
  assert.match(page.body, /id="service-form"/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const script = await request('/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.equal((await request('/styles.css')).status, 200);
  assert.equal((await request('/', 'HEAD')).body, '');
  assert.equal((await request('/', 'POST', {})).status, 405);
  for (const route of ['/src/store.js', '/package.json', '/data/service-calendar.json', '/%2e%2e/src/app.js']) {
    assert.equal((await request(route)).status, 404);
  }
});

test('service records cannot be read or changed through another equipment route', async (t) => {
  const { request, dataFile } = await fixture(t);
  const first = await request('/api/equipment', 'POST', equipment);
  const second = await request('/api/equipment', 'POST', { ...equipment, name: 'Drill' });
  const service = await request(`${first.headers.get('location')}/services`, 'POST', { date: '2026-01-01', description: 'Inspection' });
  const before = await fs.readFile(dataFile, 'utf8');
  const wrongRoute = `${second.headers.get('location')}/services/${service.body.id}`;
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    assert.equal((await request(wrongRoute, method, method === 'PATCH' ? { description: 'Wrong machine' } : undefined)).status, 404);
  }
  assert.equal(await fs.readFile(dataFile, 'utf8'), before);
  assert.equal((await request(service.headers.get('location'))).body.description, 'Inspection');
});

test('date ceiling rejects overflowing schedules without changing saved history', async (t) => {
  const { request, dataFile } = await fixture(t);
  const created = await request('/api/equipment', 'POST', { ...equipment, intervalDays: 3650 });
  const route = created.headers.get('location');
  const service = await request(`${route}/services`, 'POST', { date: '9989-12-31', description: 'Inspection' });
  assert.equal(service.status, 201);
  assert.equal((await request(route)).body.dueDate, '9999-12-29');
  const before = await fs.readFile(dataFile, 'utf8');
  assert.equal((await request(`${route}/services`, 'POST', { date: '9990-12-31', description: 'Overflow' })).status, 400);
  assert.equal((await request(service.headers.get('location'), 'PATCH', { date: '9990-12-31' })).status, 400);
  assert.equal(await fs.readFile(dataFile, 'utf8'), before);
});
