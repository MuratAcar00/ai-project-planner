const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, finish } = require('./autonomous-helpers');
const { GeneratedAppRuntimeService } = require('../src/services/generated-app-runtime-service');
const { createApp } = require('../src/app');

async function setup(t) {
  const f = await fixture(t);
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  const id = done.projectId;
  const workspace = await f.dependencies.workspaceService.getWorkspacePath(id);
  for (const dir of ['src', 'public', 'test']) await fs.mkdir(path.join(workspace, dir));
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { start: 'node src/server.js', test: 'node --test test/*.test.js' } }));
  await fs.writeFile(path.join(workspace, 'src/server.js'), "throw Error('Runtime must use the controlled launcher');");
  await fs.writeFile(path.join(workspace, 'src/app.js'), "exports.createServer=()=>require('http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',secret:process.env.FACTORY_TEST_SECRET || null}));});");
  await fs.writeFile(path.join(workspace, 'public/index.html'), '<h1>Test App</h1>');
  await fs.writeFile(path.join(workspace, 'test/app.test.js'), "require('node:test')('works',()=>{});");
  const runtime = new GeneratedAppRuntimeService({ ...f.dependencies, runtimeRoot: path.join(f.directory, 'runtime'), startupMs: 2000 });
  t.after(() => runtime.close());
  return { ...f, id, workspace, runtime };
}

test('runtime starts isolated app on allocated loopback, prevents duplicates, stops only its child', async t => {
  const f = await setup(t);
  process.env.FACTORY_TEST_SECRET = 'not-for-child';
  t.after(() => { delete process.env.FACTORY_TEST_SECRET; });
  const pending = f.runtime.start(f.id);
  assert.throws(() => f.runtime.start(f.id), /operation already/);
  const running = await pending;
  assert.equal(running.status, 'running');
  assert.ok(running.pid > 0);
  assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await (await fetch(running.url)).json()).secret, null);
  await assert.rejects(() => f.runtime.start(f.id), /already started/);
  assert.equal((await f.runtime.status(f.id)).port, running.port);
  assert.equal((await f.runtime.stop(f.id)).status, 'stopped');
  await assert.rejects(() => fetch(running.url));
  assert.equal((await f.runtime.stop(f.id)).status, 'stopped');
});

test('runtime rejects missing, incomplete, manual, traversal, symlink and unsafe package projects', async t => {
  const f = await setup(t);
  await assert.rejects(() => f.runtime.start('missing'), /not found/);
  await assert.rejects(() => f.runtime.start('../escape'), /Invalid project/);
  await f.dependencies.projectRepository.update(f.id, p => { p.status = 'In progress'; return true; });
  await assert.rejects(() => f.runtime.start(f.id), /Only completed/);
  await f.dependencies.projectRepository.update(f.id, p => { p.status = 'Completed'; p.autonomousRunId = null; return true; });
  await assert.rejects(() => f.runtime.start(f.id), /autonomous project/);
  const run = (await f.dependencies.runRepository.list())[0];
  await f.dependencies.projectRepository.update(f.id, p => { p.autonomousRunId = run.id; return true; });
  const original = await fs.readFile(path.join(f.workspace, 'package.json'));
  for (const scripts of [{ start: 'node src/server.js; echo unsafe', test: 'node --test test/*.test.js' }, { start: 'node src/server.js', prestart: 'echo unsafe', test: 'node --test test/*.test.js' }]) {
    await fs.writeFile(path.join(f.workspace, 'package.json'), JSON.stringify({ scripts }));
    await assert.rejects(() => f.runtime.start(f.id), /Unsafe workspace/);
  }
  await fs.writeFile(path.join(f.workspace, 'package.json'), original);
  await fs.symlink('/tmp', path.join(f.workspace, 'linked'));
  await assert.rejects(() => f.runtime.start(f.id), /Unsafe workspace/);
  await fs.unlink(path.join(f.workspace, 'linked'));
  await fs.rename(f.workspace, f.workspace + '-real');
  await fs.symlink(f.workspace + '-real', f.workspace);
  await assert.rejects(() => f.runtime.start(f.id), /Unsafe workspace/);
});

test('failed startup and root health fallback clean up and remain retryable', async t => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.workspace, 'src/app.js'), "throw Error('private error evidence');");
  await assert.rejects(() => f.runtime.start(f.id), /App startup failed/);
  assert.equal((await f.runtime.status(f.id)).status, 'stopped');
  assert.deepEqual(await fs.readdir(f.runtime.runtimeRoot), []);
  await fs.writeFile(path.join(f.workspace, 'src/app.js'), "exports.createServer=()=>require('http').createServer((req,res)=>{res.statusCode=req.url==='/api/health'?404:200;res.end('ok');});");
  assert.equal((await f.runtime.start(f.id)).status, 'running');
});

test('runtime HTTP controls reject all configuration and foreign origins; list and events redact evidence', async t => {
  const f = await setup(t);
  const app = createApp({ projectRepository: f.dependencies.projectRepository, executionService: f.dependencies.executionService, workspaceService: f.dependencies.workspaceService, autonomousService: f.service, runtimeService: f.runtime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/projects/${f.id}/runtime`;
  const post = (suffix, body = {}, headers = {}) => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const body of [{ workspacePath: '/tmp' }, { command: 'sh' }, { port: 3000 }, { pid: process.pid }, [], null]) {
    for (const action of ['/start', '/stop']) assert.equal((await post(action, body)).status, 400);
  }
  assert.equal((await post('/start?port=3000')).status, 400);
  assert.equal((await post('/start', {}, { Origin: 'http://untrusted.test' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = require('node:http').request(url + '/start', { method: 'POST', headers: { Host: 'untrusted.test', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post('/start', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${base}/api/projects/missing/runtime`)).status, 404);
  assert.equal((await post('/start')).status, 200);
  assert.equal((await post('/start')).status, 409);
  assert.equal((await (await fetch(url)).json()).status, 'running');
  assert.equal((await post('/stop')).status, 200);
  const run = (await f.dependencies.runRepository.list())[0];
  await f.dependencies.runRepository.update(run.id, r => { r.error = 'PRIVATE_TOKEN'; r.events[0].reason = 'PRIVATE_TOKEN'; r.validationResults = [{ output: 'PRIVATE_TOKEN' }]; return true; });
  for (const suffix of ['/api/autonomous', `/api/autonomous/${run.id}`, `/api/autonomous/${run.id}/events`, '/api/projects', `/api/projects/${f.id}/runs`]) {
    const response = await fetch(base + suffix); assert.equal(response.status, 200); assert.equal((await response.text()).includes('PRIVATE_TOKEN'), false);
  }
  for (const state of ['failed', 'paused']) {
    await f.dependencies.runRepository.update(run.id, r => { r.state = state; r.needsAttention = true; return true; });
    const resume = await fetch(`${base}/api/autonomous/${run.id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(resume.status, 409);
  }
  const list = await (await fetch(base + '/api/autonomous')).json();
  assert.equal(list[0].projectId, f.id);
  assert.equal(list[0].progress, 100);
});

test('multiple completed apps get distinct ports and unexpected exit clears runtime', async t => {
  const f = await setup(t);
  const original = await f.dependencies.projectRepository.get(f.id);
  const secondId = f.id + '-second';
  const runId = original.autonomousRunId + '-second';
  await f.dependencies.projectRepository.create({ ...original, id: secondId, autonomousRunId: runId });
  await f.dependencies.runRepository.create({ id: runId, projectId: secondId, state: 'completed' });
  await fs.cp(f.workspace, path.join(f.dependencies.workspaceService.workspaceRoot, secondId), { recursive: true });
  const [first, second] = await Promise.all([f.runtime.start(f.id), f.runtime.start(secondId)]);
  assert.notEqual(first.port, second.port);
  assert.equal((await fetch(first.url)).status, 200);
  assert.equal((await fetch(second.url)).status, 200);
  const entry = f.runtime.registry.get(secondId);
  entry.child.kill('SIGKILL');
  await entry.closed;
  await f.runtime.cleanup(secondId, entry);
  assert.equal((await f.runtime.status(secondId)).status, 'stopped');
  assert.equal((await f.runtime.status(f.id)).status, 'running');
});
