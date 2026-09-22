'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validate } = require('./domain');
const queues = new Map();

function validState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.equipment) || !Array.isArray(state.services)) return false;
  try {
    const ids = new Set();
    for (const [kind, records] of [['equipment', state.equipment], ['service', state.services]]) {
      for (const record of records) {
        const { id, createdAt, equipmentId, ...input } = record;
        if (typeof id !== 'string' || !id || ids.has(id) || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return false;
        ids.add(id);
        validate(input, kind);
        if (kind === 'service' && !state.equipment.some((item) => item.id === equipmentId)) return false;
      }
    }
    return true;
  } catch { return false; }
}

class Store {
  constructor(dataFile = path.join(__dirname, '..', 'data', 'service-calendar.json')) {
    this.dataFile = path.resolve(dataFile);
  }

  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.dataFile, 'utf8'));
      if (!validState(state)) throw new Error('Invalid data store');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, equipment: [], services: [] };
      throw error;
    }
  }

  async update(change) {
    const previous = queues.get(this.dataFile) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const state = await this.read();
      const result = change(state);
      if (!validState(state)) throw new Error('Invalid data store');
      await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
      const temporary = `${this.dataFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.dataFile);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    queues.set(this.dataFile, operation);
    try { return await operation; }
    finally { if (queues.get(this.dataFile) === operation) queues.delete(this.dataFile); }
  }
}

module.exports = { Store };
