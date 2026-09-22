const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { JsonAutonomousRunRepository } = require('../src/repositories/json-autonomous-run-repository');
const { WorkspaceService } = require('../src/services/workspace-service');
const { GeneratedProjectPublisher } = require('../src/services/generated-project-publisher');
const { ProjectPublishGit, ORIGIN, runGit } = require('../src/services/project-publish-git');
const { projectSlug } = require('../src/services/project-publish-files');
const { createApp } = require('../src/app');

const hash = value => createHash('sha1').update(value).digest('hex');
function fakeGit(root) {
  const remoteParent = '1'.repeat(40);
  const localParent = '2'.repeat(40);
  const trees = new Map([[remoteParent, new Map([['README.md', hash('remote factory')]])], [localParent, new Map([['README.md', hash('local factory')], ['src/factory.js', hash('private factory change')]])]]);
  const parents = new Map();
  const indexes = new Map();
  const calls = [];
  const realIndex = new Map([['src/staged.js', hash('staged factory')]]);
  const state = { head: localParent, remote: remoteParent, failPush: false, acceptThenFail: false, origin: ORIGIN, branch: 'main', commits: [], calls, trees, indexes, realIndex, remoteParent, localParent };
  state.execute = async (args, options) => {
    calls.push({ args, options });
    assert.equal(options.cwd, root);
    const [command, ...rest] = args;
    if (command === 'remote') return state.origin;
    if (command === 'symbolic-ref') return state.branch;
    if (command === 'fetch') return '';
    if (command === 'rev-parse') {
      const ref = args.at(-1);
      if (ref === '--show-toplevel') return root;
      if (ref === 'HEAD') return state.head;
      if (ref === 'FETCH_HEAD') return state.remote;
      if (ref.endsWith('^')) return parents.get(ref.slice(0, -1));
      if (ref.includes(':')) { const [commit, file] = ref.split(':'); return trees.get(commit)?.get(file); }
    }
    if (command === 'ls-tree') return [...trees.get(rest[3]).keys()].filter(file => file.startsWith(args.at(-1))).join('\0');
    if (command === 'read-tree') { indexes.set(options.index, new Map(trees.get(rest[0]))); return ''; }
    if (command === 'hash-object') return hash(options.input);
    if (command === 'update-index') {
      const [, object, file] = rest.at(-1).split(',');
      (options.index ? indexes.get(options.index) : realIndex).set(file, object);
      return '';
    }
    if (command === 'write-tree') {
      const tree = new Map(indexes.get(options.index));
      const id = hash(JSON.stringify([...tree]));
      trees.set(id, tree); return id;
    }
    if (command === 'commit-tree') {
      const id = hash(rest.join(' ') + options.input);
      trees.set(id, new Map(trees.get(rest[0]))); parents.set(id, rest[2]); state.commits.push(id); return id;
    }
    if (command === 'diff-tree') {
      const [before, after] = args.slice(-2).map(id => trees.get(id));
      return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).join('\0');
    }
    if (command === 'diff') return '';
    if (command === 'update-ref') { assert.equal(state.head, rest[2]); state.head = rest[1]; return ''; }
    if (command === 'push') {
      if (state.acceptThenFail) state.remote = args.at(-1).split(':')[0];
      if (state.failPush || state.acceptThenFail) throw Object.assign(new Error('Git operation failed. No automatic retry.'), { status: 502, safePublishError: true });
      state.remote = args.at(-1).split(':')[0]; return '';
    }
    throw Error('Unexpected git command: ' + args.join(' '));
  };
  return state;
}
async function setup(t) {
  const directory = await fs.mkdtemp(path.resolve('.test-tmp/publisher-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.git'));
  const projectRepository = new JsonProjectRepository(path.join(directory, 'data/projects.json'));
  const runRepository = new JsonAutonomousRunRepository(path.join(directory, 'data/runs.json'));
  const workspaceService = new WorkspaceService({ workspaceRoot: path.join(directory, 'workspaces') });
  const id = 'project-first';
  const workspace = await workspaceService.getWorkspacePath(id);
  const originals = { 'package.json': '{"scripts":{"start":"node src/server.js"}}\n', 'package-lock.json': '{}\n', 'README.md': '# Decision Log\n', '.gitignore': 'data/\n', 'src/app.js': 'exports.app = {};\n', 'src/server.js': '// server\n', 'public/index.html': '<h1>App</h1>\n', 'test/app.test.js': "require('node:test')('ok', () => {});\n" };
  for (const [file, content] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), content);
  }
  await projectRepository.create({ id, name: 'Decision Log', autonomousRunId: 'autonomous-first', status: 'Completed', plan: { phases: [] } });
  await runRepository.create({ id: 'autonomous-first', projectId: id, state: 'completed', validationPassed: true, validationResults: [{ passed: true }], events: [] });
  const fake = fakeGit(directory);
  const git = new ProjectPublishGit({ repositoryRoot: directory, execute: fake.execute });
  const dependencies = { projectRepository, runRepository, workspaceService, repositoryRoot: directory, git };
  const publisher = new GeneratedProjectPublisher(dependencies);
  const editProject = update => projectRepository.update(id, p => { Object.assign(p, update); return true; });
  const editRun = update => runRepository.update('autonomous-first', r => { Object.assign(r, update); return true; });
  return { directory, id, workspace, originals, fake, git, dependencies, publisher, editProject, editRun };
}

test('publishes only completed project sources; isolates both commit histories and preserves staged Factory files', async t => {
  const f = await setup(t);
  for (const dir of ['node_modules', 'data', '.validation', '.codex', 'coverage', 'logs']) {
    await fs.mkdir(path.join(f.workspace, dir));
    await fs.writeFile(path.join(f.workspace, dir, 'local.json'), '{"user":"private"}');
  }
  const dry = await f.publisher.dryRun(f.id);
  assert.equal(dry.secretScan, 'passed');
  assert.equal(f.fake.commits.length, 0);
  assert.equal(dry.excluded.length, 6);
  const result = await f.publisher.publish(f.id);
  assert.equal(result.publishStatus, 'published');
  assert.equal(result.githubUrl, 'https://github.com/MuratAcar00/ai-project-planner/tree/main/projects/decision-log');
  assert.equal(f.fake.commits.length, 2);
  const remoteTree = f.fake.trees.get(result.commitHash);
  assert.equal(remoteTree.get('README.md'), hash('remote factory'));
  assert.equal(remoteTree.has('src/factory.js'), false);
  assert.equal(f.fake.trees.get(f.fake.head).get('README.md'), hash('local factory'));
  assert.equal(f.fake.realIndex.get('src/staged.js'), hash('staged factory'));
  for (const file of dry.files) assert(await fs.stat(path.join(f.directory, 'projects/decision-log', file)));
  assert.equal(remoteTree.size, dry.files.length + 1);
  const stage = f.fake.calls.filter(call => call.args[0] === 'update-index');
  assert(stage.length > 0);
  assert(stage.every(call => call.args.at(-1).split(',')[2].startsWith('projects/decision-log/')));
  assert(!f.fake.calls.some(call => ['add', 'reset', 'clean', 'rebase'].includes(call.args[0])));
  const pushes = f.fake.calls.filter(call => call.args[0] === 'push');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${result.commitHash}:refs/heads/main`]);
  assert(!pushes[0].args.some(arg => arg.includes('force') || arg.startsWith('+')));
  const again = await new GeneratedProjectPublisher(f.dependencies).publish(f.id);
  assert.equal(again.publishStatus, 'published');
  assert.equal(again.commitHash, result.commitHash);
  assert.equal(f.fake.commits.length, 2);
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 1);
});

for (const status of ['In progress', 'Building', 'Failed', 'Needs Attention']) test(`rejects project status ${status}`, async t => {
  const f = await setup(t); await f.editProject({ status });
  await assert.rejects(() => f.publisher.publish(f.id), /Only completed/);
  assert.equal(f.fake.commits.length, 0);
});
for (const update of [{ state: 'failed' }, { state: 'executing' }, { validationPassed: false }, { validationResults: [{ passed: false }] }, { needsAttention: true }]) test(`rejects ineligible run ${JSON.stringify(update)}`, async t => {
  const f = await setup(t); await f.editRun(update);
  await assert.rejects(() => f.publisher.publish(f.id), /Only completed/);
});
test('rejects manual projects, unsafe IDs, invalid names and active app runtime', async t => {
  const f = await setup(t);
  assert.equal(projectSlug('Lesson Pulse'), 'lesson-pulse');
  assert.equal(projectSlug('Release Checklist'), 'release-checklist');
  for (const name of ['../escape', 'a/b', 'a\\b', '.', '---', 'x\nmessage']) assert.throws(() => projectSlug(name));
  await assert.rejects(() => f.publisher.publish('../escape'), /Invalid project/);
  await f.editProject({ name: '../escape' });
  await assert.rejects(() => f.publisher.publish(f.id), /unsafe project name/);
  await f.editProject({ name: 'Decision Log', autonomousRunId: null });
  await assert.rejects(() => f.publisher.publish(f.id), /autonomous/);
  await f.editProject({ autonomousRunId: 'autonomous-first' });
  f.publisher.runtimeService = { snapshot: () => ({ status: 'running' }) };
  await assert.rejects(() => f.publisher.publish(f.id), /Stop this app/);
});
for (const target of ['workspace', 'root', 'file', 'destination']) test(`rejects ${target} symlink without following it`, async t => {
  const f = await setup(t);
  if (target === 'workspace' || target === 'root') {
    const link = target === 'workspace' ? f.workspace : path.dirname(f.workspace);
    await fs.rename(link, link + '-real'); await fs.symlink(link + '-real', link);
  } else if (target === 'file') await fs.symlink('/etc/passwd', path.join(f.workspace, 'src/link.js'));
  else { await fs.mkdir(path.join(f.directory, 'projects')); await fs.symlink(f.workspace, path.join(f.directory, 'projects/decision-log')); }
  await assert.rejects(() => f.publisher.publish(f.id), /symlink|unsafe/i);
  assert.equal(f.fake.commits.length, 0);
});
for (const filename of ['.env', '.env.production', 'credentials.json', 'private-key.txt', 'id_ed25519', 'key.pem', 'secrets']) test(`blocks secret-like file ${filename}`, async t => {
  const f = await setup(t); await fs.writeFile(path.join(f.workspace, filename), 'sensitive');
  await assert.rejects(() => f.publisher.publish(f.id), /secret-like/);
  assert.equal(f.fake.commits.length, 0);
  assert.equal((await f.publisher.status(f.id)).publishStatus, 'needs_attention');
});
test('blocks hardcoded credentials in source, without leaking evidence', async t => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.workspace, 'src/config.js'), "const apiKey = 'private-credential-value';");
  await assert.rejects(() => f.publisher.publish(f.id), error => /possible secret/.test(error.message) && !error.message.includes('private-credential'));
  assert.equal(JSON.stringify(await f.publisher.status(f.id)).includes('private-credential'), false);
});
test('rejects filesystem, remote and project metadata slug collisions', async t => {
  const f = await setup(t);
  await fs.mkdir(path.join(f.directory, 'projects/decision-log'), { recursive: true });
  await assert.rejects(() => f.publisher.publish(f.id), /already exists/);
  await fs.rmdir(path.join(f.directory, 'projects/decision-log'));
  f.fake.trees.get(f.fake.remote).set('projects/decision-log/README.md', hash('someone else'));
  await assert.rejects(() => f.publisher.publish(f.id), /already exists/);
  f.fake.trees.get(f.fake.remote).delete('projects/decision-log/README.md');
  await f.dependencies.projectRepository.create({ id: 'other', publishing: { publishedSlug: 'decision-log' } });
  await assert.rejects(() => f.publisher.publish(f.id), /already owns/);
});
test('rejects changed origin or branch before any copy or commit', async t => {
  const f = await setup(t);
  f.fake.origin = 'git@github.com:elsewhere/unsafe.git';
  await assert.rejects(() => f.publisher.publish(f.id), /fixed origin/);
  f.fake.origin = ORIGIN; f.fake.branch = 'other';
  await assert.rejects(() => f.publisher.publish(f.id), /local main/);
  assert.equal(f.fake.commits.length, 0);
});
test('failed push does not retry; explicit retry reuses commits and metadata survives service restart', async t => {
  const f = await setup(t); f.fake.failPush = true;
  await assert.rejects(() => f.publisher.publish(f.id), /Git operation failed/);
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 1);
  assert.equal(f.fake.commits.length, 2);
  assert.equal((await f.publisher.status(f.id)).publishStatus, 'needs_attention');
  f.fake.failPush = false;
  assert.equal((await new GeneratedProjectPublisher(f.dependencies).publish(f.id)).publishStatus, 'published');
  assert.equal(f.fake.commits.length, 2);
});
test('reconciles a push that succeeded before connection loss without pushing twice', async t => {
  const f = await setup(t); f.fake.acceptThenFail = true;
  await assert.rejects(() => f.publisher.publish(f.id));
  assert.equal((await new GeneratedProjectPublisher(f.dependencies).publish(f.id)).publishStatus, 'published');
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 1);
});
test('pending publication rejects changed sources and remote divergence', async t => {
  const f = await setup(t); f.fake.failPush = true;
  await assert.rejects(() => f.publisher.publish(f.id));
  await fs.writeFile(path.join(f.workspace, 'README.md'), '# changed');
  await assert.rejects(() => f.publisher.publish(f.id), /Workspace changed/);
  await fs.writeFile(path.join(f.workspace, 'README.md'), f.originals['README.md']);
  f.fake.remote = '9'.repeat(40);
  await assert.rejects(() => f.publisher.publish(f.id), /Remote main changed/);
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 1);
});
test('cross-instance lock blocks simultaneous publishing and remains untouched', async t => {
  const f = await setup(t);
  const lock = path.join(f.directory, '.git/factory-publish.lock');
  await fs.writeFile(lock, 'another publisher');
  await assert.rejects(() => f.publisher.publish(f.id), /locked/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another publisher');
  assert.equal(f.fake.commits.length, 0);
});
test('publish API accepts only empty JSON, rejects foreign origin/host and exposes a safe DTO', async t => {
  const f = await setup(t);
  const autonomousService = { runRepository: f.dependencies.runRepository, initialize: async () => {} };
  const app = createApp({ projectRepository: f.dependencies.projectRepository, autonomousService, executionService: { initialize: async () => {} }, publisherService: f.publisher });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/projects/${f.id}/publish`;
  const post = (body, headers = {}, suffix = '') => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const field of ['path', 'command', 'remote', 'branch', 'commitMessage', 'githubUrl']) assert.equal((await post({ [field]: 'unsafe' })).status, 400);
  for (const body of [[], null, 'text']) assert.equal((await post(body)).status, 400);
  assert.equal((await post({}, {}, '?branch=main')).status, 400);
  assert.equal((await post({}, { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await post({}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = require('node:http').request(url, { method: 'POST', headers: { Host: 'evil.test', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(hostStatus, 403);
  assert.equal((await post({})).status, 200);
  await f.dependencies.projectRepository.update(f.id, p => { p.publishing.secret = 'PRIVATE_CREDENTIAL'; p.publishing.githubUrl = 'javascript:PRIVATE_CREDENTIAL'; return true; });
  const response = await fetch(url);
  const dto = await response.json();
  assert.equal(dto.publishStatus, 'published');
  assert(!JSON.stringify(dto).includes('PRIVATE_CREDENTIAL'));
  assert.deepEqual(Object.keys(dto).sort(), ['projectId', 'publishStatus', 'canPublish', 'publishedSlug', 'publishedAt', 'commitHash', 'githubUrl', 'message'].sort());
});

// Local plumbing smoke test: process mocked for all network commands, actual
// Git only for an isolated temporary repository. No GitHub access is possible.
test('real local Git plumbing produces isolated commits while network process is mocked', async t => {
  const f = await setup(t);
  const local = args => runGit(args, { cwd: f.directory });
  await local(['init', '-b', 'main']);
  await fs.writeFile(path.join(f.directory, 'README.md'), 'remote factory');
  await local(['add', '--', 'README.md']);
  await local(['commit', '-m', 'initial']);
  const remoteHead = await local(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(f.directory, 'README.md'), 'local checkpoint');
  await local(['add', '--', 'README.md']);
  await local(['commit', '-m', 'local checkpoint']);
  await fs.mkdir(path.join(f.directory, 'src'));
  await fs.writeFile(path.join(f.directory, 'src/factory.js'), 'staged factory');
  await local(['add', '--', 'src/factory.js']);
  const stagedBefore = await local(['diff', '--cached']);
  let pushed;
  f.publisher.git = new ProjectPublishGit({ repositoryRoot: f.directory, execute: async (args, options) => {
    if (args[0] === 'remote') return ORIGIN;
    if (args[0] === 'fetch') return '';
    if (args.at(-1) === 'FETCH_HEAD') return remoteHead;
    if (args[0] === 'push') { pushed = args.at(-1).split(':')[0]; return ''; }
    return runGit(args, options);
  } });
  const published = await f.publisher.publish(f.id);
  assert.equal(published.commitHash, pushed);
  assert.equal(await local(['show', `${pushed}:README.md`]), 'remote factory');
  assert.equal(await local(['show', 'HEAD:README.md']), 'local checkpoint');
  assert.equal(await local(['diff', '--cached']), stagedBefore);
  const changed = (await local(['show', '--pretty=format:', '--name-only', 'HEAD'])).split('\n').filter(Boolean);
  assert(changed.length > 5 && changed.every(file => file.startsWith('projects/decision-log/')));
});

test('rejects a Git tree containing Factory paths before push', async t => {
  const f = await setup(t);
  const execute = f.fake.execute;
  f.publisher.git.execute = async (args, options) => {
    if (args[0] === 'diff-tree') return 'projects/decision-log/README.md\0src/factory.js';
    return execute(args, options);
  };
  await assert.rejects(() => f.publisher.publish(f.id), /unexpected paths/);
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 0);
});
test('runtime data files and unsupported assets are omitted; source/config and lockfiles remain', async t => {
  const f = await setup(t);
  for (const file of ['src/users.json', 'public/decisions.json', 'debug.log', 'local.sqlite', 'scratch.tmp', 'unknown.txt']) await fs.writeFile(path.join(f.workspace, file), '{}');
  await fs.mkdir(path.join(f.workspace, 'config'));
  await fs.writeFile(path.join(f.workspace, 'config/app.json'), '{"theme":"light"}');
  const dry = await f.publisher.dryRun(f.id);
  for (const file of ['src/users.json', 'public/decisions.json', 'debug.log', 'local.sqlite', 'scratch.tmp', 'unknown.txt']) assert(dry.excluded.includes(file));
  assert(dry.files.includes('config/app.json'));
  assert(dry.files.includes('package-lock.json'));
});
test('published destination modifications and hardlinks are rejected', async t => {
  const f = await setup(t);
  await fs.link(path.join(f.workspace, 'README.md'), path.join(f.workspace, 'src/linked.md'));
  await assert.rejects(() => f.publisher.publish(f.id), /unsafe file/i);
  await fs.unlink(path.join(f.workspace, 'src/linked.md'));
  f.fake.failPush = true;
  await assert.rejects(() => f.publisher.publish(f.id));
  await fs.writeFile(path.join(f.directory, 'projects/decision-log/README.md'), 'changed');
  await assert.rejects(() => f.publisher.publish(f.id), /files differ/);
  assert.equal(f.fake.calls.filter(c => c.args[0] === 'push').length, 1);
});
test('Git process wrapper ignores inherited repository redirects', async t => {
  const f = await setup(t);
  await runGit(['init', '-b', 'main'], { cwd: f.directory });
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent-untrusted-git-dir';
  try { assert.equal(await runGit(['rev-parse', '--show-toplevel'], { cwd: f.directory }), f.directory); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
});
