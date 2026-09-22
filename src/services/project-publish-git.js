const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { fail, safeDirectory } = require('./project-publish-files');
const ORIGIN = 'git@github.com:MuratAcar00/ai-project-planner.git';
const WEB_ROOT = 'https://github.com/MuratAcar00/ai-project-planner/tree/main/projects/';
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

// execFile never starts a shell. Do not inherit GIT_DIR, GIT_INDEX_FILE,
// GIT_CONFIG_*, SSH command overrides, tracing or askpass from the server.
function runGit(args, { cwd, index, input } = {}) {
  const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  if (index) env.GIT_INDEX_FILE = index;
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=/usr/bin/ssh -oBatchMode=yes', '-c', 'commit.gpgSign=false', '-c', 'user.name=Autonomous App Factory', '-c', 'user.email=factory@users.noreply.github.com', '-c', 'remote.origin.mirror=false', ...args],
      { cwd, env, shell: false, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(fail('Git operation failed. Check repository access or remote changes; no automatic retry was made.', 502));
        else resolve(stdout.trim());
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
class ProjectPublishGit {
  constructor({ repositoryRoot, execute = runGit }) { Object.assign(this, { repositoryRoot, execute }); }
  git(args, options = {}) { return this.execute(args, { cwd: this.repositoryRoot, ...options }); }
  async preflight() {
    await safeDirectory(this.repositoryRoot);
    await safeDirectory(path.join(this.repositoryRoot, '.git'));
    if (await this.git(['rev-parse', '--show-toplevel']) !== this.repositoryRoot || await this.git(['symbolic-ref', '--short', 'HEAD']) !== 'main') throw fail('Publishing requires the configured repository on local main.');
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      if (await this.git(args) !== ORIGIN) throw fail('Publishing requires the fixed origin repository.');
    }
  }
  async remoteHead() {
    await this.preflight();
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/main']);
    const head = await this.git(['rev-parse', '--verify', 'FETCH_HEAD']);
    if (!oid(head)) throw fail('Invalid remote commit.');
    return head;
  }
  async treeFiles(head, prefix) {
    const listing = await this.git(['ls-tree', '-r', '--name-only', '-z', head, '--', prefix]);
    return listing.split('\0').filter(Boolean);
  }
  async createCommit(parent, prefix, files, message, index) {
    if (!oid(parent) || !/^projects\/[a-z0-9][a-z0-9-]{0,79}\/$/.test(prefix)) throw fail('Unsafe Git publish boundary.');
    if ((await this.treeFiles(parent, prefix)).length) throw fail('Project slug already exists in Git history.');
    await this.git(['read-tree', parent], { index });
    for (const file of files) {
      if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file.relative) || file.relative.split('/').some(part => part === '..' || part === '.')) throw fail('Unsafe Git filename.');
      const hash = await this.git(['hash-object', '-w', '--stdin', '--no-filters'], { input: file.buffer });
      if (!oid(hash)) throw fail('Invalid Git object.');
      // An isolated index avoids staging any Factory changes, including already
      // staged changes. No filters, attributes, hooks or generated scripts run.
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${hash},${prefix}${file.relative}`], { index });
    }
    const tree = await this.git(['write-tree'], { index });
    if (!oid(tree)) throw fail('Invalid Git tree.');
    const commit = await this.git(['commit-tree', tree, '-p', parent], { input: `${message}\n` });
    if (!oid(commit)) throw fail('Invalid Git commit.');
    await this.verifyCommit(commit, parent, prefix, files);
    return commit;
  }
  async verifyCommit(commit, parent, prefix, files) {
    if (!oid(commit) || !oid(parent)) throw fail('Invalid publish commit metadata.');
    if (await this.git(['rev-parse', `${commit}^`]) !== parent) throw fail('Publish commit has an unexpected parent.');
    const changed = (await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parent, commit])).split('\0').filter(Boolean).sort();
    const expected = files.map(file => prefix + file.relative).sort();
    if (JSON.stringify(changed) !== JSON.stringify(expected) || changed.some(file => !file.startsWith(prefix))) throw fail('Publish commit includes unexpected paths.');
    for (const file of files) {
      const hash = await this.git(['hash-object', '--stdin', '--no-filters'], { input: file.buffer });
      if (await this.git(['rev-parse', `${commit}:${prefix}${file.relative}`]) !== hash) throw fail('Publish commit content changed.');
    }
  }
  async attachLocal(commit, parent, prefix, files) {
    // Preserve every existing Factory index entry. Only the generated paths are
    // inserted to match the new local HEAD; compare-and-swap rejects races.
    if (await this.git(['diff', '--cached', '--name-only', '--', prefix])) throw fail('Generated project path already has staged changes.');
    await this.git(['update-ref', 'refs/heads/main', commit, parent]);
    for (const file of files) {
      const hash = await this.git(['rev-parse', `${commit}:${prefix}${file.relative}`]);
      if (!oid(hash)) throw fail('Invalid local publish object.');
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${hash},${prefix}${file.relative}`]);
    }
  }
  async push(commit) {
    if (!oid(commit)) throw fail('Invalid publish commit.');
    await this.preflight();
    // This commit is a direct child of origin/main, never of local Factory
    // history. Explicit refspec, no tags, no force, no configured extra refs.
    await this.git(['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${commit}:refs/heads/main`]);
  }
}
module.exports = { ProjectPublishGit, runGit, ORIGIN, WEB_ROOT, oid };
