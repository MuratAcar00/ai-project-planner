'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { collections, saveRecord } = require('./domain');
const emptyState = () => Object.fromEntries(collections.map((name) => [name, []]));
function createStore(filePath = path.join(__dirname, '..', 'data', 'coverage.json')) {
  let state = emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || Object.keys(parsed).length !== collections.length || collections.some((name) => !Array.isArray(parsed[name]))) throw new Error('Invalid storage shape');
    for (const name of collections) {
      const ids = new Set();
      for (const row of parsed[name]) {
        if (!row || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || ids.has(row.id)) throw new Error('Invalid stored ID');
        ids.add(row.id);
        const { id, ...body } = row;
        const record = saveRecord(state, name, body);
        record.id = id;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to load coverage storage', { cause: error });
  }
  return {
    read: () => structuredClone(state),
    mutate(operation) {
      const next = structuredClone(state);
      const result = operation(next);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      state = next;
      return structuredClone(result);
    }
  };
}
module.exports = { createStore };
