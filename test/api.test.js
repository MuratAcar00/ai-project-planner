const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

let server, baseUrl, dataFile, project;
async function request(pathname, options) { return fetch(`${baseUrl}${pathname}`, options); }
const input = { name: 'Focus Flow', description: 'A web app that helps remote workers focus using timed sessions.', platform: 'Web', technology: 'JavaScript', experienceLevel: 'Intermediate' };

test.before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-test-'));
  dataFile = path.join(dir, 'projects.json');
  server = createApp({ dataFile }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(path.dirname(dataFile), { recursive: true, force: true }); });

test('creates a project with a structured plan', async () => {
  const response = await request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 201); project = await response.json();
  assert.equal(project.name, input.name); assert.equal(project.plan.phases.length, 4); assert.equal(project.remainingTasks, 12);
});
test('lists projects', async () => { const response = await request('/api/projects'); assert.equal(response.status, 200); const list = await response.json(); assert.equal(list.length, 1); assert.equal(list[0].id, project.id); });
test('retrieves a project', async () => { const response = await request(`/api/projects/${project.id}`); assert.equal(response.status, 200); const found = await response.json(); assert.equal(found.plan.architecture.includes('web'), true); });
test('completes a task and updates progress', async () => { const taskId = project.plan.phases[0].tasks[0].id; const response = await request(`/api/projects/${project.id}/tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: true }) }); assert.equal(response.status, 200); const updated = await response.json(); assert.equal(updated.completedTasks, 1); assert.equal(updated.progress, 8); });
test('rejects invalid project input', async () => { const response = await request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', platform: 'Invalid' }) }); assert.equal(response.status, 400); const body = await response.json(); assert.ok(body.fields.name); assert.ok(body.fields.platform); });
test('returns 404 for a nonexistent project', async () => { const response = await request('/api/projects/no-such-project'); assert.equal(response.status, 404); assert.equal((await response.json()).error, 'Project not found.'); });
test('deletes a project', async () => { const response = await request(`/api/projects/${project.id}`, { method: 'DELETE' }); assert.equal(response.status, 204); const check = await request(`/api/projects/${project.id}`); assert.equal(check.status, 404); });
