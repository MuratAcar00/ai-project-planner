const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { WorkspaceService } = require('../src/services/workspace-service');
const { FlutterWorkspaceScaffolder, FLUTTER_ARGS } = require('../src/services/flutter-workspace-scaffolder');

async function setup(t, runCommand) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flutter-scaffold-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new JsonProjectRepository(path.join(directory, 'projects.json'));
  const workspaceService = new WorkspaceService({ workspaceRoot: path.join(directory, 'workspaces') });
  const project = { id: 'mobile-project', targetPlatform: 'mobile', flutterScaffold: null };
  await repository.create(project);
  const scaffolder = new FlutterWorkspaceScaffolder({ workspaceService, projectRepository: repository, runCommand });
  return { directory, repository, workspaceService, project, scaffolder };
}

test('mobile scaffold invokes fixed Flutter CLI args with shell disabled and persists completion once', async t => {
  const calls = [];
  const f = await setup(t, async (...args) => { calls.push(args); });
  const result = await f.scaffolder.prepare(f.project, 'run-mobile');
  assert.equal(result.prepared, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'flutter');
  assert.deepEqual(calls[0][1], FLUTTER_ARGS);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].cwd, await f.workspaceService.getWorkspacePath(f.project.id));
  assert.equal((await f.repository.get(f.project.id)).flutterScaffold.status, 'completed');
  assert.equal((await f.scaffolder.prepare(f.project, 'run-restart')).skipped, true);
  assert.equal(calls.length, 1);
});

test('failed or interrupted scaffold is infrastructure failure and never invoked a second time', async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; throw Object.assign(new Error('flutter unavailable'), { stderr: 'flutter unavailable' }); });
  const failed = await f.scaffolder.prepare(f.project, 'run-mobile');
  assert.equal(failed.infrastructureError, true);
  assert.equal((await f.repository.get(f.project.id)).flutterScaffold.status, 'failed');
  const restart = await f.scaffolder.prepare(f.project, 'run-mobile');
  assert.equal(restart.infrastructureError, true);
  assert.equal(calls, 1);
  await f.repository.update(f.project.id, stored => { stored.flutterScaffold.status = 'attempted'; return true; });
  assert.equal((await f.scaffolder.prepare(f.project, 'run-mobile')).infrastructureError, true);
  assert.equal(calls, 1);
});

test('web and web_mobile do not invoke Flutter scaffolding', async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; });
  for (const targetPlatform of ['web', 'web_mobile']) {
    assert.equal((await f.scaffolder.prepare({ ...f.project, targetPlatform }, 'run')).skipped, true);
  }
  assert.equal(calls, 0);
});
