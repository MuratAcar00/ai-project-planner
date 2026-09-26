const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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
  return { ...f, workspace, manifest, calls, validation: new WorkspaceValidationService({ workspaceService: f.dependencies.workspaceService, projectRepository: f.dependencies.projectRepository, runner }) };
}

async function flutterValidationFixture(t, result) {
  const f = await fixture(t);
  const projectId = 'flutter-validation-fixture';
  const workspace = await f.dependencies.workspaceService.getWorkspacePath(projectId);
  for (const file of ['pubspec.yaml', 'lib/main.dart', 'test/widget_test.dart', 'ios/Runner.xcodeproj/project.pbxproj']) {
    const target = path.join(workspace, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.endsWith('.yaml') ? 'name: fixture\n' : '// fixture');
  }
  await fs.mkdir(path.join(workspace, 'android'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'android', 'gradle', 'wrapper'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-all.zip\n');
  await f.dependencies.projectRepository.create({ id: projectId, targetPlatform: 'mobile' });
  const calls = [];
  const cachePath = path.join(workspace, '.validation', 'fake-flutter-cache');
  const runner = {
    async prepareFlutterCache() { await fs.mkdir(cachePath, { recursive: true }); return { path: cachePath }; },
    async prepareGradleDistribution() { return { version: '9.3.1', distribution: 'gradle-9.3.1-all.zip', path: path.join(workspace, '.validation', 'gradle', 'wrapper', 'dists', 'gradle-9.3.1-all', 'fakehash') }; },
    async cleanupFlutterCache() { await fs.rm(cachePath, { recursive: true, force: true }); },
    async run(cwd, command, args, options) { calls.push({ cwd, command, args, options }); return result ? result(command, args) : { passed: true, output: 'All tests passed' }; }
  };
  const validation = new WorkspaceValidationService({ workspaceService: f.dependencies.workspaceService, projectRepository: f.dependencies.projectRepository, runner });
  return { ...f, workspace, projectId, calls, validation };
}

test('mobile validation runs Flutter tests followed by the Android debug APK build', async t => {
  const f = await flutterValidationFixture(t);
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks.map(check => check.name), ['flutter-test', 'android-debug-apk']);
  assert.deepEqual(result.artifactStatus, { androidApk: { status: 'built' } });
  assert.deepEqual(f.calls.map(call => [call.command, call.args]), [['flutter', ['test']], ['flutter', ['build', 'apk', '--debug']]]);
  assert.ok(f.calls.every(call => call.cwd === f.workspace));
  assert.ok(f.calls.every(call => call.options.flutterCachePath === path.join(f.workspace, '.validation', 'fake-flutter-cache')));
  assert.equal(await fs.stat(path.join(f.workspace, '.validation', 'fake-flutter-cache')).then(() => true, () => false), false);
});

test('Flutter tests remain required while APK application failures are diagnostic only', async t => {
  const appFailure = await flutterValidationFixture(t, (_command, args) => ({ passed: args[0] !== 'build', output: args[0] === 'build' ? 'Gradle task assembleDebug failed: Dart compilation error in lib/main.dart' : 'All tests passed' }));
  const applicationResult = await appFailure.validation.validate({ projectId: appFailure.projectId });
  assert.equal(applicationResult.passed, true);
  assert.equal(applicationResult.checks.at(-1).name, 'android-debug-apk');
  assert.deepEqual(applicationResult.artifactStatus, { androidApk: { status: 'build-failed' } });
  const toolchain = await flutterValidationFixture(t, () => ({ passed: false, output: 'Android SDK not found. Define a valid SDK location.' }));
  const infrastructureResult = await toolchain.validation.validate({ projectId: toolchain.projectId });
  assert.equal(infrastructureResult.infrastructureError, true);
  assert.equal(infrastructureResult.checks[0].name, 'flutter-test');
  assert.equal(toolchain.calls.length, 1);
});

test('Flutter test failure blocks application validation and skips optional APK build', async t => {
  const f = await flutterValidationFixture(t, (_command, args) => ({ passed: false, output: args[0] === 'test' ? 'Expected true but was false in lib/main.dart' : '' }));
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, false);
  assert.equal(result.infrastructureError, false);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, 'flutter-test');
  assert.equal(f.calls.length, 1);
});

test('APK Gradle infrastructure failure is optional and recorded while application validation passes', async t => {
  const f = await flutterValidationFixture(t, (_command, args) => args[0] === 'build'
    ? { passed: false, infrastructureError: true, exitCode: 1, output: 'Gradle wrapper unavailable in offline sandbox.' }
    : { passed: true, output: '00:00 +17: All tests passed!' });
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, true);
  assert.equal(result.infrastructureError, false);
  assert.equal(result.checks[0].passed, true);
  assert.equal(result.checks[1].infrastructureError, true);
  assert.deepEqual(result.artifactStatus, { androidApk: { status: 'infrastructure-unavailable' } });
});

test('Flutter SDK read-only cache/bootstrap errors are classified as infrastructure before APK build', async t => {
  const f = await flutterValidationFixture(t, () => ({ passed: false, exitCode: 1,
    output: '/flutter/bin/internal/update_engine_version.sh: line 71: engine.stamp.tmp.14: Read-only file system\nengine.realm: Read-only file system' }));
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.infrastructureError, true);
  assert.equal(result.checks[0].name, 'flutter-test');
  assert.equal(result.checks[0].infrastructureError, true);
  assert.equal(f.calls.length, 1);
});

test('Flutter Java and which discovery failures are classified as infrastructure', async t => {
  const output = 'ProcessException: Failed to find "which" in the search path.\n  Command: which ';
  const f = await flutterValidationFixture(t, (_command, args) => args[0] === 'build'
    ? { passed: false, exitCode: 1, output }
    : { passed: true, output: 'All tests passed' });
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, true);
  assert.equal(result.infrastructureError, false);
  assert.equal(result.checks[0].passed, true);
  assert.equal(result.checks[1].name, 'android-debug-apk');
  assert.equal(result.checks[1].infrastructureError, true);
});

test('JDK security configuration startup failures are classified as infrastructure', async t => {
  const output = 'Exception in thread "main" java.lang.InternalError: Error loading java.security file';
  const f = await flutterValidationFixture(t, (_command, args) => args[0] === 'build'
    ? { passed: false, exitCode: 1, signal: null, timedOut: false, output }
    : { passed: true, output: 'All tests passed' });
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, true);
  assert.equal(result.infrastructureError, false);
  assert.equal(result.checks[1].name, 'android-debug-apk');
  assert.equal(result.checks[1].infrastructureError, true);
});

test('Flutter SDK cache seeding failure is infrastructure and launches no validation command', async t => {
  const f = await flutterValidationFixture(t);
  f.validation.runner.prepareFlutterCache = async () => { throw Object.assign(new Error('read-only SDK cache'), { code: 'EROFS' }); };
  const result = await f.validation.validate({ projectId: f.projectId });
  assert.equal(result.passed, false);
  assert.equal(result.infrastructureError, true);
  assert.equal(result.checks[0].name, 'flutter-sdk-cache');
  assert.equal(f.calls.length, 0);
});

test('Gradle wrapper URL selects and privately seeds only its exact trusted cached distribution', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gradle-cache-sandbox-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const cacheRoot = path.join(root, 'trusted', 'wrapper', 'dists');
  const hash = 'abc123trusted';
  const source = path.join(cacheRoot, 'gradle-9.3.1-all', hash);
  await fs.mkdir(path.join(workspace, 'android', 'gradle', 'wrapper'), { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(source, 'gradle-9.3.1', 'bin'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.validation', 'gradle'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-all.zip\n');
  await fs.writeFile(path.join(source, 'gradle-9.3.1-all.zip'), 'trusted archive');
  await fs.writeFile(path.join(source, 'gradle-9.3.1-all.zip.ok'), '');
  await fs.writeFile(path.join(source, 'gradle-9.3.1', 'bin', 'gradle'), '#!/bin/sh\n');
  await fs.chmod(path.join(source, 'gradle-9.3.1', 'bin', 'gradle'), 0o755);
  const sourceBefore = {
    archive: await fs.readFile(path.join(source, 'gradle-9.3.1-all.zip'), 'utf8'),
    executableMode: (await fs.stat(path.join(source, 'gradle-9.3.1', 'bin', 'gradle'))).mode & 0o777,
    distributionMode: (await fs.stat(path.join(source, 'gradle-9.3.1'))).mode & 0o777
  };
  const runner = new SandboxValidationRunner({ gradleCacheRoot: cacheRoot });
  const selected = await runner.prepareGradleDistribution(workspace);
  assert.equal(selected.version, '9.3.1');
  assert.equal(selected.distribution, 'gradle-9.3.1-all.zip');
  assert.equal(await fs.readFile(path.join(selected.path, selected.distribution), 'utf8'), 'trusted archive');
  assert.equal(await fs.readFile(path.join(selected.path, 'gradle-9.3.1', 'bin', 'gradle'), 'utf8'), '#!/bin/sh\n');
  assert.equal((await fs.stat(path.join(selected.path, 'gradle-9.3.1', 'bin', 'gradle'))).mode & 0o111, 0o111);
  assert.equal((await fs.stat(path.join(selected.path, 'gradle-9.3.1'))).mode & 0o700, 0o700);
  assert.notEqual(selected.path, source);
  assert.equal((await fs.stat(path.join(selected.path, selected.distribution))).mode & 0o777, 0o600);
  assert.deepEqual({
    archive: await fs.readFile(path.join(source, 'gradle-9.3.1-all.zip'), 'utf8'),
    executableMode: (await fs.stat(path.join(source, 'gradle-9.3.1', 'bin', 'gradle'))).mode & 0o777,
    distributionMode: (await fs.stat(path.join(source, 'gradle-9.3.1'))).mode & 0o777
  }, sourceBefore);
  let invocation;
  runner.flutterExecutable = '/tmp/flutter/bin/flutter';
  runner.resolveFlutterExecutable = async () => '/tmp/flutter/bin/flutter';
  runner.flutterToolchainAliases = async () => [];
  runner.flutterJavaSecurityConfigDirectories = async () => [];
  runner.spawnProcess = (_command, args, options) => {
    invocation = { args, options };
    const process = child();
    setImmediate(() => process.emit('close', 0, null));
    return process;
  };
  const flutterCachePath = path.join(workspace, '.validation', 'fake-flutter-cache');
  await fs.mkdir(flutterCachePath);
  await runner.run(workspace, 'flutter', ['build', 'apk', '--debug'], { flutterCachePath, gradleDistributionPath: selected.path });
  assert.equal(invocation.args.some((value, index) => ['--bind', '--ro-bind'].includes(value) && invocation.args[index + 1]?.startsWith(path.join(root, 'trusted'))), false);
  assert.equal(invocation.args.some((value, index) => value === '--bind' && invocation.args[index + 1] === root), false);
  assert.equal(invocation.options.shell, false);
  assert.ok(invocation.args.includes('--unshare-all'));
});

test('Gradle archive without the extracted distribution is insufficient for offline wrapper cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gradle-partial-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const hash = 'trustedhash';
  const source = path.join(root, 'trusted', 'gradle-9.3.1-all', hash);
  await fs.mkdir(path.join(workspace, 'android', 'gradle', 'wrapper'), { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(workspace, '.validation', 'gradle'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-all.zip\n');
  await fs.writeFile(path.join(source, 'gradle-9.3.1-all.zip'), 'archive only');
  await fs.writeFile(path.join(source, 'gradle-9.3.1-all.zip.ok'), '');
  const runner = new SandboxValidationRunner({ gradleCacheRoot: path.join(root, 'trusted') });
  await assert.rejects(() => runner.prepareGradleDistribution(workspace), /unavailable or ambiguous/);
  assert.equal(await fs.stat(path.join(workspace, '.validation', 'gradle', 'wrapper', 'dists')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(source, 'gradle-9.3.1-all.zip'), 'utf8'), 'archive only');
});

test('Gradle wrapper missing extracted-directory error is infrastructure while application compile errors remain repairable', async () => {
  const { FailureAnalyzer } = require('../src/services/failure-analyzer');
  const analyzer = new FailureAnalyzer();
  assert.equal(analyzer.analyze({ kind: 'validation', message: "Gradle distribution '/workspace/.validation/gradle/wrapper/dists/gradle-9.3.1-all/hash' does not contain any directories. Expected to find exactly 1 directory." }).category, 'infrastructure');
  assert.equal(analyzer.analyze({ kind: 'validation', message: 'Gradle task assembleDebug failed: Dart compilation error in lib/main.dart' }).category, 'validation');
});

test('missing or unsafe Gradle distributions remain optional APK infrastructure diagnostics', async t => {
  for (const { url, expected } of [
    { url: 'https\\://services.gradle.org/distributions/gradle-8.9-bin.zip', expected: /unavailable/ },
    { url: 'https\\://evil.example/gradle-9.3.1-all.zip', expected: /unsupported or unsafe/ },
    { url: 'file\\:///tmp/gradle-9.3.1-all.zip', expected: /unsupported or unsafe/ },
    { url: 'https\\://services.gradle.org/distributions/../../host.zip', expected: /unsupported or unsafe/ }
  ]) {
    const f = await flutterValidationFixture(t);
    f.validation.runner.prepareGradleDistribution = SandboxValidationRunner.prototype.prepareGradleDistribution.bind(f.validation.runner);
    await fs.writeFile(path.join(f.workspace, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionUrl=${url}\n`);
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gradle-cache-missing-test-'));
    t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
    f.validation.runner.gradleCacheRoot = cacheRoot;
    const result = await f.validation.validate({ projectId: f.projectId });
    assert.equal(result.passed, true);
    assert.equal(result.infrastructureError, false);
    assert.equal(result.checks.at(-1).name, 'android-debug-apk');
    assert.equal(result.checks.at(-1).infrastructureError, true);
    assert.match(result.checks.at(-1).error, expected);
    assert.deepEqual(result.artifactStatus, { androidApk: { status: 'infrastructure-unavailable', message: result.checks.at(-1).error } });
    assert.deepEqual(f.calls.map(call => call.args), [['test']]);
  }
});

test('Gradle wrapper network and distribution download failures are infrastructure', async t => {
  for (const output of [
    'java.net.UnknownHostException: services.gradle.org',
    'Failed to download Gradle distribution https://services.gradle.org/distributions/gradle-9.3.1-all.zip',
    "Gradle distribution '/workspace/.validation/gradle/wrapper/dists/gradle-9.3.1-all/hash' does not contain any directories. Expected to find exactly 1 directory."
  ]) {
    const f = await flutterValidationFixture(t, (_command, args) => args[0] === 'build'
      ? { passed: false, exitCode: 1, output }
      : { passed: true, output: 'All tests passed' });
    f.validation.runner.prepareGradleDistribution = async () => ({ version: '9.3.1', distribution: 'gradle-9.3.1-all.zip', path: path.join(f.workspace, '.validation', 'gradle') });
    const result = await f.validation.validate({ projectId: f.projectId });
    assert.equal(result.passed, true);
    assert.equal(result.infrastructureError, false);
    assert.equal(result.checks[1].infrastructureError, true);
    assert.equal(f.calls.length, 2);
  }
});

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

test('Flutter cache is privately seeded, mounted over the read-only SDK cache for both commands, and cleaned up', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flutter-cache-sandbox-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const flutterRoot = path.join(root, 'flutter-sdk');
  const sourceCache = path.join(flutterRoot, 'bin', 'cache');
  await fs.mkdir(path.join(workspace, '.validation'), { recursive: true });
  await fs.mkdir(sourceCache, { recursive: true });
  await fs.writeFile(path.join(flutterRoot, 'bin', 'flutter'), '#!/bin/sh\n');
  await fs.writeFile(path.join(sourceCache, 'engine.stamp'), 'installed-engine\n');
  await fs.writeFile(path.join(sourceCache, 'engine.realm'), '');
  const invocations = [];
  const runner = new SandboxValidationRunner({ flutterExecutable: path.join(flutterRoot, 'bin', 'flutter'), spawnProcess(command, args, options) {
    invocations.push({ command, args, options });
    const process = child();
    setImmediate(() => { process.stdout.emit('data', 'Flutter validation output'); process.emit('close', 0, null); });
    return process;
  } });
  runner.flutterToolchainAliases = async () => [
    { name: 'which', target: '/usr/bin/which.debianutils', destination: '/etc/alternatives/which' },
    { name: 'java', target: '/usr/lib/jvm/java-17-openjdk-amd64/bin/java', destination: '/etc/alternatives/java' }
  ];
  runner.flutterJavaSecurityConfigDirectories = async javaExecutable => {
    assert.equal(javaExecutable, '/usr/lib/jvm/java-17-openjdk-amd64/bin/java');
    return ['/etc/java-17-openjdk/security'];
  };
  const cache = await runner.prepareFlutterCache(workspace);
  assert.equal(await fs.readFile(path.join(cache.path, 'engine.stamp'), 'utf8'), 'installed-engine\n');
  assert.notEqual(cache.path, sourceCache);
  await fs.writeFile(path.join(cache.path, 'engine.realm'), 'private-change');
  assert.equal(await fs.readFile(path.join(sourceCache, 'engine.realm'), 'utf8'), '');
  for (const args of [['test'], ['build', 'apk', '--debug']]) {
    assert.equal((await runner.run(workspace, 'flutter', args, { flutterCachePath: cache.path })).passed, true);
  }
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.command, '/usr/bin/bwrap');
    assert.ok(invocation.args.includes('--unshare-all'));
    assert.ok(invocation.args.some((value, index) => value === '--ro-bind' && invocation.args[index + 1] === flutterRoot && invocation.args[index + 2] === flutterRoot));
    assert.ok(invocation.args.some((value, index) => value === '--bind' && invocation.args[index + 1] === cache.path && invocation.args[index + 2] === path.join(flutterRoot, 'bin', 'cache')));
    assert.ok(invocation.args.some((value, index) => value === '--ro-bind' && invocation.args[index + 1] === '/etc/java-17-openjdk/security' && invocation.args[index + 2] === '/run/autonomous-jdk-security-0'));
    assert.ok(invocation.args.some((value, index) => value === '--symlink' && invocation.args[index + 1] === '/run/autonomous-jdk-security-0' && invocation.args[index + 2] === '/etc/java-17-openjdk/security'));
    assert.ok(invocation.args.some((value, index) => value === '--chmod' && invocation.args[index + 1] === '0555' && invocation.args[index + 2] === '/run'));
    assert.ok(invocation.args.some((value, index) => value === '--chmod' && invocation.args[index + 1] === '0555' && invocation.args[index + 2] === '/etc/java-17-openjdk'));
    const securityBindIndex = invocation.args.findIndex((value, index) => value === '--ro-bind' && invocation.args[index + 1] === '/etc/java-17-openjdk/security');
    const sandboxEtcIndex = invocation.args.findIndex((value, index) => value === '--dir' && invocation.args[index + 1] === '/etc');
    assert.ok(securityBindIndex >= 0 && securityBindIndex < sandboxEtcIndex);
    assert.ok(invocation.args.includes('--dir') && invocation.args.includes('/etc/alternatives'));
    for (const alias of [
      ['/usr/bin/which.debianutils', '/etc/alternatives/which'],
      ['/usr/lib/jvm/java-17-openjdk-amd64/bin/java', '/etc/alternatives/java']
    ]) assert.ok(invocation.args.some((value, index) => value === '--symlink' && invocation.args[index + 1] === alias[0] && invocation.args[index + 2] === alias[1]));
    assert.ok(invocation.args.some((value, index) => value === '--chmod' && invocation.args[index + 1] === '0555' && invocation.args[index + 2] === '/etc/alternatives'));
    assert.ok(invocation.args.some((value, index) => value === '--chmod' && invocation.args[index + 1] === '0555' && invocation.args[index + 2] === '/etc'));
    assert.equal(invocation.args.some((value, index) => value === '--ro-bind' && invocation.args[index + 1] === '/etc'), false);
    assert.ok(invocation.args.includes('--bind'));
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.cwd, workspace);
    assert.equal(invocation.args.includes('--share-net'), false);
  }
  assert.deepEqual(invocations[0].args.slice(-2), [path.join(flutterRoot, 'bin', 'flutter'), 'test']);
  assert.deepEqual(invocations[1].args.slice(-4), [path.join(flutterRoot, 'bin', 'flutter'), 'build', 'apk', '--debug']);
  await runner.cleanupFlutterCache(workspace, cache);
  assert.equal(await fs.stat(cache.path).then(() => true, () => false), false);
  await assert.rejects(() => runner.run(workspace, 'flutter', ['build', 'ios'], { flutterCachePath: cache.path }));
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

test('npm configuration paths are distinct and config initialization errors are infrastructure', async t => {
  const f = await validationFixture(t, () => ({ passed: false, output: 'double-loading config "/dev/null" as "global", previously loaded as "user"' }));
  const result = await f.validation.validate({ projectId: 'validation-fixture' });
  assert.equal(result.infrastructureError, true);
  const args = f.calls[0].args;
  assert.ok(args.includes('--userconfig=/dev/null'));
  assert.ok(args.includes('--globalconfig=/workspace/.validation/empty-global.npmrc'));
  assert.equal(await fs.readFile(path.join(f.workspace, '.validation/empty-global.npmrc'), 'utf8'), '');
});

test('empty root Git metadata is excluded from source inspection and validation passes', async t => {
  const f = await validationFixture(t);
  await fs.mkdir(path.join(f.workspace, '.git'));
  assert.ok(!(await f.validation.inspect(f.workspace)).files.includes('.git'));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, true);
});

test('Git metadata pointers, populated metadata and nested Git fail closed for operator review', async t => {
  for (const kind of ['pointer', 'populated', 'nested']) {
    const f = await validationFixture(t);
    const git = path.join(f.workspace, kind === 'nested' ? 'src/.git' : '.git');
    if (kind === 'pointer') await fs.writeFile(git, 'gitdir: ../../outside');
    else {
      await fs.mkdir(git);
      if (kind === 'populated') await fs.writeFile(path.join(git, 'config'), 'test metadata');
    }
    const result = await f.validation.validate({ projectId: 'validation-fixture' });
    assert.equal(result.passed, false);
    assert.equal(result.infrastructureError, true);
    assert.equal(f.calls.length, 0);
  }
});

test('sensitive filenames and Git symlinks remain rejected with safe relative paths', async t => {
  for (const name of ['.env', '.env.production', '.npmrc', 'private.key', 'private.pem', 'private-key.txt', 'credentials.json', 'secret-token', 'id_rsa']) {
    const f = await validationFixture(t);
    await fs.writeFile(path.join(f.workspace, name), 'fixture');
    const result = await f.validation.validate({ projectId: 'validation-fixture' });
    assert.equal(result.passed, false, name);
    assert.ok(result.checks[0].error.includes(JSON.stringify(name)));
    assert.equal(f.calls.length, 0);
  }
  const f = await validationFixture(t);
  await fs.symlink(f.directory, path.join(f.workspace, '.git'));
  assert.match((await f.validation.validate({ projectId: 'validation-fixture' })).checks[0].error, /Symlinks/);
});

test('workspace traversal and validation-directory symlinks cannot escape the workspace', async t => {
  const f = await validationFixture(t);
  await assert.rejects(() => f.dependencies.workspaceService.getWorkspacePath('../outside'), /not valid/);
  await fs.symlink(f.directory, path.join(f.workspace, '.validation'));
  assert.equal((await f.validation.validate({ projectId: 'validation-fixture' })).passed, false);
  assert.equal(f.calls.length, 0);
});

test('validator exceptions return infrastructure evidence rather than application failures', async t => {
  const f = await validationFixture(t);
  f.validation.runner.run = async () => { throw new Error('runner initialization failed'); };
  const result = await f.validation.validate({ projectId: 'validation-fixture' });
  assert.equal(result.infrastructureError, true);
  assert.equal(result.checks[0].name, 'validation-infrastructure');
});
