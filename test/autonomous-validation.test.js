const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fixture } = require('./autonomous-helpers');
const { WorkspaceValidationService, SandboxValidationRunner } = require('../src/services/workspace-validation-service');

async function validationFixture(t, result) {
  const f = await fixture(t);
  const workspace = await f.dependencies.workspaceService.getWorkspacePath('validation-fixture');
  for (const dir of ['src', 'public', 'test']) await fs.mkdir(path.join(workspace, dir));
  const manifest = { name: 'fixture', version: '1.0.0', scripts: { start: 'node src/server.js', test: 'node --test test/*.test.js' } };
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify(manifest));
  for (const file of ['src/server.js', 'src/app.js', 'public/index.html', 'test/app.test.js']) await fs.writeFile(path.join(workspace, file), '// fixture');
  const calls = [];
  const runner = { async run(cwd, command, args) { calls.push({ cwd, command, args }); return result ? result(command, args) : { passed: true, output: '# tests 1\n# pass 1' }; } };
  return { ...f, workspace, manifest, calls, validation: new WorkspaceValidationService({ workspaceService: f.dependencies.workspaceService, runner }) };
}

test('validation runs offline install, syntax checks, tests and startup health with fixed arguments', async t => {
  const f = await validationFixture(t);
  const result = await f.validation.validate({ projectId: 'validation-fixture' });
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks.map(check => check.name), ['install', 'syntax:src/app.js', 'syntax:src/server.js', 'syntax:test/app.test.js', 'tests', 'startup-health']);
  assert.ok(f.calls[0].args.includes('--ignore-scripts'));
  assert.ok(f.calls[0].args.includes('--offline'));
  assert.equal(f.calls[0].cwd, f.workspace);
  assert.equal(f.calls.at(-1).command, 'node');
  assert.match(f.calls.at(-1).args[1], /api\/health/);
});

test('validation stops on first command failure and retains diagnostic evidence', async t => {
  const f = await validationFixture(t, (command) => ({ passed: command !== 'npm', output: 'install failed', exitCode: 1 }));
  const result = await f.validation.validate({ projectId: 'validation-fixture' });
  assert.equal(result.passed, false);
  assert.equal(f.calls.length, 1);
  assert.equal(result.checks[0].output, 'install failed');
});

test('validation rejects nonzero dependencies, arbitrary scripts, lock dependencies, and no test files', async t => {
  for (const mutation of [
    manifest => { manifest.dependencies = { paid: '1' }; },
    manifest => { manifest.scripts.postinstall = 'unsafe'; },
    manifest => { manifest.scripts.test = 'echo done'; },
    manifest => { manifest.scripts.build = 'curl nowhere'; }
  ]) {
    const f = await validationFixture(t); mutation(f.manifest);
    await fs.writeFile(path.join(f.workspace, 'package.json'), JSON.stringify(f.manifest));
    assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
    assert.equal(f.calls.length, 0);
  }
  const f = await validationFixture(t);
  await fs.writeFile(path.join(f.workspace, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/evil': {} } }));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
  await fs.unlink(path.join(f.workspace, 'package-lock.json'));
  await fs.unlink(path.join(f.workspace, 'test/app.test.js'));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
});

test('validation rejects symlinks and sensitive filenames before reading or spawning', async t => {
  const f = await validationFixture(t);
  await fs.symlink(f.directory, path.join(f.workspace, 'escape'));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
  await fs.unlink(path.join(f.workspace, 'escape'));
  await fs.writeFile(path.join(f.workspace, '.env'), 'test fixture only');
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
  assert.equal(f.calls.length, 0);
});

test('zero-test success is not accepted as a tested MVP', async t => {
  const f = await validationFixture(t, () => ({ passed: true, output: '# tests 0' }));
  const result = await f.validation.validate({ projectId: 'validation-fixture' });
  assert.equal(result.passed, false);
  assert.equal(result.checks.at(-1).name, 'tests');
});

function child() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter(); process.stdout.destroy = () => {};
  process.stderr = new EventEmitter(); process.stderr.destroy = () => {};
  process.kill = signal => { process.signal = signal; return true; };
  return process;
}

test('sandbox runner clears environment and mounts only workspace writable without network', async () => {
  let observed;
  const runner = new SandboxValidationRunner({ outputLimit: 20, spawnProcess(command, args, options) {
    observed = { command, args, options };
    const process = child();
    setImmediate(() => { process.stdout.emit('data', 'x'.repeat(80)); process.emit('close', 0, null); });
    return process;
  } });
  const result = await runner.run('/tmp/fixture', 'node', ['--test', 'test/a.test.js']);
  assert.equal(result.passed, true);
  assert.equal(result.output.length, 20);
  assert.equal(observed.command, '/usr/bin/bwrap');
  assert.ok(observed.args.includes('--unshare-all'));
  assert.ok(observed.args.includes('--clearenv'));
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.env, { PATH: '/usr/bin:/bin' });
  assert.equal(observed.args.filter(value => value === '--bind').length, 1);
  assert.equal(observed.args.includes('--share-net'), false);
  await assert.rejects(() => runner.run('/tmp', 'sh', []));
});

test('sandbox absence and timeout fail closed with bounded completion', async () => {
  const absent = new SandboxValidationRunner({ spawnProcess() { throw new Error('not found'); } });
  assert.equal((await absent.run('/tmp', 'node', [])).infrastructureError, true);
  const process = child();
  const timeout = new SandboxValidationRunner({ timeoutMs: 10, spawnProcess: () => process });
  const result = await timeout.run('/tmp', 'node', []);
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.equal(process.signal, 'SIGKILL');
});

test('all-skipped test suite cannot complete an MVP', async t => {
  const f = await validationFixture(t, () => ({ passed: true, output: '# tests 3\n# pass 0\n# skipped 3' }));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
});
