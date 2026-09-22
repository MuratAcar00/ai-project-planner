const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const fail = (message, status = 409) => Object.assign(new Error(message), { status, safePublishError: true });
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const markerName = '.factory-publish.json';
function projectSlug(name) {
  if (typeof name !== 'string' || name.length > 120 || /[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw fail('Needs Attention: unsafe project name.');
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw fail('Needs Attention: project name cannot form a safe slug.');
  return slug;
}
async function safeDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw fail('Needs Attention: unsafe directory or symlink.');
  return stat;
}
const secretName = name => /(^\.env($|\.)|secrets?|credentials?|private[-_]?key|^id_(rsa|dsa|ecdsa|ed25519)($|\.)|\.(pem|key|p12|pfx|keystore)$|^\.(npmrc|netrc|pypirc|aws|ssh)$)/i.test(name);
const ignoredDirectory = name => /^(node_modules|data|database|databases|storage|uploads|runtime|tmp|temp|cache|coverage|logs|dist|build|\.git|\.cache|\.validation|\.codex|\.agents|\.next|\.test-tmp|test-results)$/i.test(name) || /^\.test-data-/.test(name);
const ignoredFile = name => /^(?:users?|customers?|decisions?|records?|sessions?|runtime[-_]?data|app[-_]?data)(?:[._-].*)?\.(?:json|csv|xml)$/i.test(name) || /\.(log|sqlite3?|db|db3|bak|tmp|temp|swp|pid|sock|session|jsonl)$/i.test(name) || /^(npm-debug|yarn-error)/.test(name);
const sourceFile = relative => {
  if (!relative.includes('/')) return /^(package(?:-lock)?\.json|README(?:\.md)?|LICENSE(?:\.md)?|\.gitignore|(?:jsconfig|tsconfig|eslint\.config|vite\.config|webpack\.config)[a-z0-9.-]*\.(?:json|js|mjs|cjs))$/i.test(relative);
  return /^(src|public|test|tests|lib|config|docs|assets|components)\//.test(relative) && /\.(js|mjs|cjs|jsx|ts|tsx|json|html|css|scss|md|txt|svg|xml|yaml|yml)$/i.test(relative);
};
function scanContent(buffer) {
  const value = buffer.toString('utf8');
  if (buffer.includes(0) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})|(?:https?|postgres(?:ql)?|mysql|mongodb):\/\/[^\s/:]+:[^\s/@]+@/i.test(value) || /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i.test(value)) {
    throw fail('Needs Attention: possible secret or unsupported binary content detected. Nothing was published.');
  }
}
async function readRegular(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw fail('Needs Attention: unsafe file or file size limit exceeded.');
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw fail('Workspace changed during inspection. Please retry after it stops.');
    return buffer;
  } finally { await handle.close(); }
}
async function inspectWorkspace(workspace) {
  await safeDirectory(workspace);
  const files = [];
  const excluded = [];
  let bytes = 0;
  let entries = 0;
  async function visit(directory, depth = 0) {
    await safeDirectory(directory);
    if (depth > 12) throw fail('Needs Attention: workspace depth limit exceeded.');
    for (const name of (await fs.readdir(directory)).sort()) {
      if (++entries > 3000) throw fail('Needs Attention: workspace file limit exceeded.');
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw fail('Needs Attention: unsupported filename.');
      const target = path.join(directory, name);
      const relative = path.relative(workspace, target).split(path.sep).join('/');
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw fail('Needs Attention: workspace contains a symlink.');
      if (secretName(name)) throw fail('Needs Attention: secret-like filename detected. Nothing was published.');
      if (stat.isDirectory()) {
        if (ignoredDirectory(name)) excluded.push(`${relative}/`);
        else await visit(target, depth + 1);
      } else if (stat.isFile()) {
        if (ignoredFile(name)) { excluded.push(relative); continue; }
        await safeDirectory(directory);
        const buffer = await readRegular(target);
        scanContent(buffer);
        if (!sourceFile(relative)) { excluded.push(relative); continue; }
        bytes += buffer.length;
        if (files.length >= 500 || bytes > 10 * 1024 * 1024) throw fail('Needs Attention: publish size limit exceeded.');
        files.push({ relative, buffer, hash: digest(buffer) });
      } else throw fail('Needs Attention: only regular source files may be published.');
    }
  }
  await visit(workspace);
  for (const required of ['package.json', 'README.md', 'src/app.js', 'src/server.js', 'public/index.html']) {
    if (!files.some(file => file.relative === required)) throw fail('Needs Attention: required application source is missing.');
  }
  if (!files.some(file => /^test\/.*\.test\.js$/.test(file.relative))) throw fail('Needs Attention: application tests are missing.');
  return { files, excluded };
}
module.exports = { fail, digest, markerName, projectSlug, safeDirectory, inspectWorkspace, readRegular };
