const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ignoredDirectories = new Set(['node_modules', '.git', 'logs', 'log', 'cache', '.cache', 'runtime', '.runtime', 'validation', '.validation', 'coverage', 'dist', 'build', 'tmp', 'temp', 'test-results']);
const volatileKey = /^(?:id|.*(?:timestamp|date|time|duration|elapsed|path|cwd|pid|attempt|runid|projectid|taskid|validationid|executionrunid))$/i;
const absolutePath = /(?:\b[A-Za-z]:\\[^\s"'<>]+|(?<![\w.])\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)/g;
const isoTimestamp = /\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/g;
const clockTimestamp = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const epochTimestamp = /\b\d{10,13}\b/g;
const generatedId = /\b(?:autonomous|project|task|validation|execution)-[a-z0-9_-]+\b/gi;

function normalizedString(value) {
  return value.replace(isoTimestamp, '<time>').replace(clockTimestamp, '<time>').replace(epochTimestamp, '<time>')
    .replace(absolutePath, '<path>').replace(generatedId, '<id>').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  if (typeof value === 'string') return normalizedString(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !volatileKey.test(key)).map(key => [key, canonical(value[key])]));
}

function failureFingerprint(failure) {
  return createHash('sha256').update(JSON.stringify(canonical(failure))).digest('hex');
}

async function workspaceFingerprint(workspacePath) {
  const root = await fs.realpath(workspacePath);
  const hash = createHash('sha256');
  const noFollow = constants.O_NOFOLLOW || 0;

  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (ignoredDirectories.has(entry.name.toLowerCase())) continue;
        try { hash.update(relativePath).update('\0symlink\0').update(await fs.readlink(path.join(directory, entry.name))).update('\0'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase())) await visit(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let handle;
      try {
        handle = await fs.open(path.join(directory, entry.name), constants.O_RDONLY | noFollow);
        const details = await handle.stat();
        if (!details.isFile()) continue;
        const content = await handle.readFile();
        hash.update(relativePath).update('\0').update(content).update('\0');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ELOOP') throw error;
      } finally {
        await handle?.close();
      }
    }
  }

  await visit(root);
  return hash.digest('hex');
}

module.exports = { failureFingerprint, workspaceFingerprint };
