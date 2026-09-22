'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError, validateDocument } = require('./domain');

function createStore(filePath) {
  let queue = Promise.resolve();
  async function read() {
    let raw;
    try { raw = await fs.readFile(filePath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const documents = JSON.parse(raw);
    if (!Array.isArray(documents)) throw new Error('Invalid document storage.');
    const ids = new Set();
    for (const doc of documents) {
      if (!doc || typeof doc.id !== 'string' || ids.has(doc.id)
        || typeof doc.createdAt !== 'string' || typeof doc.updatedAt !== 'string') throw new Error('Invalid stored document.');
      ids.add(doc.id);
      try {
        validateDocument({ title: doc.title, owner: doc.owner, expiryDate: doc.expiryDate, category: doc.category, notes: doc.notes });
      } catch { throw new Error('Invalid stored document.'); }
    }
    return documents;
  }
  function mutate(operation) {
    const job = queue.then(async () => {
      const documents = await read();
      const result = operation(documents);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(documents, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filePath);
      } finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    queue = job.catch(() => {});
    return job;
  }
  return {
    async list() { await queue; return read(); },
    create(input) {
      const fields = validateDocument(input);
      return mutate(documents => {
        const now = new Date().toISOString();
        const doc = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
        documents.push(doc);
        return doc;
      });
    },
    update(id, input, partial = true) {
      const fields = validateDocument(input, partial);
      return mutate(documents => {
        const index = documents.findIndex(doc => doc.id === id);
        if (index < 0) throw new AppError(404, 'Document not found.');
        documents[index] = { ...documents[index], ...fields, updatedAt: new Date().toISOString() };
        return documents[index];
      });
    },
    remove(id) {
      return mutate(documents => {
        const index = documents.findIndex(doc => doc.id === id);
        if (index < 0) throw new AppError(404, 'Document not found.');
        documents.splice(index, 1);
      });
    }
  };
}

module.exports = { createStore };
