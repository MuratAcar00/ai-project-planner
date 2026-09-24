const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { failureFingerprint, workspaceFingerprint } = require('../src/autonomous/repair-progress');

test('failure fingerprints ignore timestamps, generated identifiers and absolute paths deterministically', () => {
  const first = { kind: 'validation', validationId: 'validation-one', timestamp: '2026-01-01T10:00:00Z',
    message: 'Tests failed in /tmp/workspace/src/app.js at 2026-01-01T10:00:00Z; run task-a1' };
  const second = { kind: 'validation', validationId: 'validation-two', timestamp: '2027-02-03T11:30:00Z',
    message: 'Tests failed in /var/tmp/other/src/app.js at 2027-02-03T11:30:00Z; run task-b2' };
  assert.equal(failureFingerprint(first), failureFingerprint(first));
  assert.equal(failureFingerprint(first), failureFingerprint(second));
  assert.notEqual(failureFingerprint(first), failureFingerprint({ ...second, checkName: 'syntax:src/app.js' }));
});

test('workspace fingerprints hash stable file paths and contents, ignore artifacts and mtimes, and skip symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src');
  await fs.mkdir(source);
  const app = path.join(source, 'app.js');
  await fs.writeFile(app, 'const answer = 42;\n');
  const baseline = await workspaceFingerprint(root);
  await fs.utimes(app, new Date(1000), new Date(2000));
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'cache'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(root, 'validation'), { recursive: true });
  for (const directory of ['node_modules', '.git', 'logs', 'cache', 'runtime', 'validation']) {
  await fs.writeFile(path.join(root, directory, 'volatile.txt'), `${directory} ${Date.now()}`);
  }
  assert.equal(await workspaceFingerprint(root), baseline);
  const outside = path.join(root, '..', `outside-${path.basename(root)}`);
  const outsideDirectory = path.join(root, '..', `outside-dir-${path.basename(root)}`);
  t.after(async () => { await fs.rm(outside, { force: true }); await fs.rm(outsideDirectory, { recursive: true, force: true }); });
  await fs.writeFile(outside, 'outside secret');
  await fs.symlink(outside, path.join(root, 'linked-file'));
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, 'linked.js'), 'outside directory content');
  await fs.symlink(outsideDirectory, path.join(root, 'linked-directory'), 'dir');
  const withSymlinks = await workspaceFingerprint(root);
  assert.notEqual(withSymlinks, baseline);
  await fs.writeFile(outside, 'changed external target');
  await fs.writeFile(path.join(outsideDirectory, 'linked.js'), 'changed external directory target');
  assert.equal(await workspaceFingerprint(root), withSymlinks);
  await fs.writeFile(app, 'const answer = 43;\n');
  assert.notEqual(await workspaceFingerprint(root), withSymlinks);
});
