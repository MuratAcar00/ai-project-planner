const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexExecutionProvider, buildTaskPrompt } = require('../src/providers/codex-execution-provider');
const { TemplateExecutionProvider } = require('../src/providers/template-execution-provider');
const { ExecutionService } = require('../src/services/execution-service');
const { WorkspaceService } = require('../src/services/workspace-service');
const { JsonProjectRepository } = require('../src/repositories/json-project-repository');
const { createTask, createPhase, createPlan } = require('../src/domain');

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'planner-codex-test-'));
}

function childProcess(onStart) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  setImmediate(() => onStart(child));
  return child;
}

function providerWith(onStart, options = {}) {
  return new CodexExecutionProvider({ spawnProcess: (...args) => {
    providerWith.calls.push(args);
    return childProcess(onStart);
  }, ...options });
}
providerWith.calls = [];

const task = { id: 'task-codex', title: 'Implement <feature>', description: 'Add the feature safely.', acceptanceCriteria: ['Tests pass'], dependencies: ['task-setup'] };

test('CodexExecutionProvider has the codex provider name and builds a bounded task prompt', () => {
  const provider = new CodexExecutionProvider({ spawnProcess() { throw new Error('not used'); } });
  const prompt = buildTaskPrompt(task, { workspacePath: '/tmp/workspace' });

  assert.equal(provider.name, 'codex');
  assert.equal(provider.requiresWorkspace, true);
  assert.match(prompt, /Implement <feature>/);
  assert.match(prompt, /Add the feature safely/);
  assert.match(prompt, /Tests pass/);
  assert.match(prompt, /task-setup/);
  assert.match(prompt, /only within the working directory/);
});

test('CodexExecutionProvider requires an absolute, existing workspace directory', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = new CodexExecutionProvider({ spawnProcess() { throw new Error('not used'); } });

  await assert.rejects(() => provider.executeTask(task, {}), /requires a workspace path/);
  await assert.rejects(() => provider.executeTask(task, { workspacePath: 'relative-path' }), /must be absolute/);
  await assert.rejects(() => provider.executeTask(task, { workspacePath: path.join(directory, 'missing') }), /does not exist/);
  const file = path.join(directory, 'not-a-directory');
  await fs.writeFile(file, 'x');
  await assert.rejects(() => provider.executeTask(task, { workspacePath: file }), /must be a directory/);
});

test('CodexExecutionProvider reports a missing Codex CLI clearly', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = new CodexExecutionProvider({ spawnProcess() {
    return childProcess(child => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
  } });

  await assert.rejects(() => provider.executeTask(task, { projectId: 'project-codex', runId: 'run-codex', workspacePath: directory }), /Codex CLI is not installed or not available in PATH/);
});

test('CodexExecutionProvider returns structured successful output without losing stdout or stderr', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  providerWith.calls = [];
  const provider = providerWith(child => {
    child.stdout.emit('data', 'changed src/app.js\n');
    child.stderr.emit('data', 'test warning\n');
    child.emit('close', 0, null);
  });

  const result = await provider.executeTask(task, { projectId: 'project-codex', runId: 'run-codex', workspacePath: directory });

  assert.deepEqual({ provider: result.provider, taskId: result.taskId, projectId: result.projectId, runId: result.runId, exitCode: result.exitCode, signal: result.signal, success: result.success }, { provider: 'codex', taskId: 'task-codex', projectId: 'project-codex', runId: 'run-codex', exitCode: 0, signal: null, success: true });
  assert.equal(result.stdout, 'changed src/app.js\n');
  assert.equal(result.stderr, 'test warning\n');
  assert.equal(providerWith.calls[0][0], 'codex');
  assert.deepEqual(providerWith.calls[0][1].slice(0, 9), ['--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '--cd', directory, '--skip-git-repo-check', '--color']);
  assert.equal(providerWith.calls[0][2].shell, false);
});

test('CodexExecutionProvider records non-zero and timeout failures with captured output', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const failing = providerWith(child => {
    child.stdout.emit('data', 'partial output');
    child.stderr.emit('data', 'failure details');
    child.emit('close', 2, null);
  });
  await assert.rejects(
    () => failing.executeTask(task, { projectId: 'project-codex', runId: 'run-failure', workspacePath: directory }),
    error => error.message === 'Codex execution failed with exit code 2.' && error.executionResult.stdout === 'partial output' && error.executionResult.stderr === 'failure details' && error.executionResult.success === false
  );

  const timingOut = providerWith(() => {}, { minTimeoutMs: 1, timeoutMs: 5, killGraceMs: 5 });
  await assert.rejects(
    () => timingOut.executeTask(task, { projectId: 'project-codex', runId: 'run-timeout', workspacePath: directory }),
    error => /timed out/.test(error.message) && error.executionResult.success === false && error.executionResult.signal === 'SIGTERM'
  );
});

test('ExecutionService selects Codex safely and keeps the template provider working', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspaceRoot = path.join(directory, 'workspaces');
  const repository = new JsonProjectRepository(path.join(directory, 'projects.json'));
  const codex = providerWith(child => child.emit('close', 0, null));
  const codexTask = createTask({ id: 'task-codex-service', title: 'Use Codex', estimate: '1 hour' });
  const templateTask = createTask({ id: 'task-template-service', title: 'Use template', estimate: '1 hour' });
  const project = { id: 'project-codex-service', status: 'Planning', plan: createPlan({ phases: [createPhase({ name: 'Build', goal: 'Build', tasks: [codexTask, templateTask] })] }), runs: [] };
  await repository.create(project);
  const service = new ExecutionService({ projectRepository: repository, workspaceService: new WorkspaceService({ workspaceRoot }), providers: [new TemplateExecutionProvider(), codex] });

  const codexResult = await service.executeTask(project, codexTask, { provider: 'codex' });
  const templateResult = await service.executeTask(project, templateTask, { provider: 'template' });

  assert.equal(codexResult.task.result.provider, 'codex');
  assert.equal(codexResult.run.status, 'completed');
  assert.equal(templateResult.task.result.message, 'Template execution completed for task: Use template.');
  assert.equal(templateResult.run.status, 'completed');
  assert.match(codexResult.task.result.stdout, /^$/);
});

for (const scenario of ['nonzero', 'spawn throw', 'process error', 'timeout', 'kill throws', 'stream error']) {
  test(`background Codex ${scenario} persists failed task and run`, async t => {
    const directory = await temporaryDirectory();
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const repository = new JsonProjectRepository(path.join(directory, 'projects.json'));
    const assigned = createTask({ title: 'Mock Codex' });
    const project = { id: 'project-fixture', plan: createPlan({ phases: [{ tasks: [assigned] }] }), runs: [] };
    await repository.create(project);
    const provider = new CodexExecutionProvider({ minTimeoutMs: 1, timeoutMs: 10, killGraceMs: 5, spawnProcess() {
      if (scenario === 'spawn throw') throw new Error('Spawn failed');
      const child = childProcess(child => {
        if (scenario === 'nonzero') child.emit('close', 2, null);
        if (scenario === 'process error') child.emit('error', new Error('Process failed'));
        if (scenario === 'stream error') child.stdout.emit('error', new Error('Stream failed'));
      });
      if (scenario === 'kill throws') child.kill = () => { throw new Error('Signal failed'); };
      return child;
    } });
    const service = new ExecutionService({ projectRepository: repository, workspaceService: new WorkspaceService({ workspaceRoot: path.join(directory, 'workspaces') }), providers: [provider] });
    const accepted = await service.startTask(project, assigned, { provider: 'codex' });
    await service.jobs.get(accepted.run.id);
    const stored = await repository.get(project.id);
    assert.equal(stored.runs[0].status, 'failed');
    assert.equal(stored.plan.phases[0].tasks[0].status, 'failed');
    assert.equal(stored.runs[0].error.message, stored.plan.phases[0].tasks[0].error);
    assert.equal(stored.runs[0].error.output.success, false);
    if (scenario === 'nonzero') assert.equal(stored.runs[0].error.output.exitCode, 2);
  });
}

function lifecycleFixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const kills = [];
  child.kill = signal => { kills.push(signal); return true; };
  const provider = new CodexExecutionProvider({ spawnProcess: () => child, killGraceMs: 10, streamCloseTimeoutMs: 10, ...options });
  const promise = provider.runCodex([], { task, context: { workspacePath: '/unused' }, timeoutMs: 30 });
  return { child, kills, promise };
}

for (const code of [0, 2]) {
  test(`exit ${code} drains trailing output before close and cancels execution timeout`, async () => {
    const { child, kills, promise } = lifecycleFixture({ streamCloseTimeoutMs: 1000 });
    const outcome = promise.catch(error => error.executionResult);
    child.emit('exit', code, null);
    child.stdout.emit('data', 'trailing output');
    child.stderr.emit('end');
    await new Promise(resolve => setTimeout(resolve, 45));
    child.emit('close', code, null);
    const result = await outcome;
    assert.equal(result.stdout, 'trailing output');
    assert.equal(result.exitCode, code);
    assert.equal(result.success, code === 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(kills, []);
  });
}

test('exit with unclosed output is bounded and distinguished from execution timeout', async () => {
  const { child, kills, promise } = lifecycleFixture();
  const outcome = promise.catch(error => error.executionResult);
  child.emit('exit', 0, null);
  child.stdout.emit('end'); // stderr never closes
  const result = await outcome;
  assert.equal(result.terminationReason, 'stdio_timeout');
  assert.equal(result.timedOut, false);
  assert.equal(result.outputIncomplete, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(kills, []);
  child.emit('close', 0, null);
  child.emit('error', new Error('late error'));
  assert.equal(result.success, false);
});

test('timeout followed by exit zero remains an explicit timeout failure', async () => {
  const { child, kills, promise } = lifecycleFixture();
  child.kill = signal => {
    kills.push(signal);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    return true;
  };
  await assert.rejects(promise, error => {
    const result = error.executionResult;
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationReason, 'timeout');
    assert.equal(result.exitCode, 0); // Preserve the observed OS exit, do not invent a code.
    assert.equal(result.requestedSignal, 'SIGTERM');
    assert.equal(result.signal, null);
    assert.equal(result.success, false);
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(kills, ['SIGTERM']);
});

for (const behavior of ['false', 'throw']) {
  test(`timeout settles when kill returns ${behavior} and no close arrives`, async () => {
    const { child, kills, promise } = lifecycleFixture();
    child.kill = signal => { kills.push(signal); if (behavior === 'throw') throw new Error('kill failure'); return false; };
    await assert.rejects(promise, error => error.executionResult.timedOut && error.executionResult.requestedSignal === 'SIGKILL' && error.executionResult.signal === null);
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
    child.emit('close', 0, null);
    child.stderr.emit('error', new Error('late stream error'));
  });
}

test('close wins before timeout and late events cannot mutate successful result', async () => {
  const { child, kills, promise } = lifecycleFixture();
  child.emit('close', 0, null);
  const result = await promise;
  child.emit('error', new Error('late process error'));
  child.stdout.emit('error', new Error('late stream error'));
  child.stdout.emit('data', 'late output');
  child.emit('exit', 2, null);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(result.success, true);
  assert.equal(result.stdout, '');
  assert.equal(result.timedOut, false);
  assert.deepEqual(kills, []);
});

test('stream failure terminates process and remains primary when close follows', async () => {
  const { child, kills, promise } = lifecycleFixture();
  child.kill = signal => { kills.push(signal); child.emit('close', 0, null); return true; };
  child.stderr.emit('error', new Error('broken output'));
  await assert.rejects(promise, error => error.executionResult.terminationReason === 'stream_error' && !error.executionResult.success);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('real local fixture receives immediate stdin EOF with positional prompt', async t => {
  const { spawn } = require('node:child_process');
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = new CodexExecutionProvider({ spawnProcess(command, args, options) {
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    // Only Node is executed. This fixture imitates the CLI reading additional stdin.
    return spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF received'));"], options);
  } });
  const result = await provider.executeTask(task, { workspacePath: directory });
  assert.equal(result.stdout, 'EOF received');
  assert.equal(result.success, true);
});

test('isolated Codex runtime preserves a read-only host and only mounts runtime and assigned workspace writable', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  const provider = new CodexExecutionProvider({ isolatedRuntimeRoot: path.join(directory, 'runtime') });
  const invocation = await provider.prepareInvocation(['exec', '--sandbox', 'workspace-write'], workspace);
  assert.equal(invocation.command, '/usr/bin/bwrap');
  assert.deepEqual(invocation.args.slice(2, 5), ['--ro-bind', '/', '/']);
  const binds = invocation.args.flatMap((value, i) => value === '--bind' ? [invocation.args.slice(i + 1, i + 3)] : []);
  assert.equal(binds.length, 2);
  assert.ok(binds[0][0].startsWith(path.join(directory, 'runtime', 'execution-')));
  assert.equal(binds[0][1], path.join(process.env.HOME, '.codex'));
  assert.deepEqual(binds[1], [workspace, workspace]);
  assert.equal(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  await fs.symlink(path.join(directory, 'runtime'), path.join(directory, 'link'));
  await assert.rejects(() => new CodexExecutionProvider({ isolatedRuntimeRoot: path.join(directory, 'link') }).prepareInvocation([], workspace), /Unsafe Codex runtime/);
});
