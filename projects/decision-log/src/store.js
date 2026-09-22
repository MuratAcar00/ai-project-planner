'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateDecision } = require('./validation');

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

class DecisionStore {
  constructor(filePath = path.join(__dirname, '..', 'data', 'decisions.json')) {
    this.filePath = path.resolve(filePath);
    this.queue = Promise.resolve();
  }

  async read() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error('Invalid decision storage');
    const ids = new Set();
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.id) || ids.has(record.id) ||
          !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt) ||
          !['title', 'context', 'decision', 'alternatives', 'tags', 'reviewDate'].every(key => Object.hasOwn(record, key))) {
        throw new Error('Invalid stored decision');
      }
      ids.add(record.id);
      const { id, createdAt, updatedAt, ...data } = record;
      try { validateDecision(data); } catch { throw new Error('Invalid stored decision'); }
    }
    return records;
  }

  async list() {
    await this.queue;
    return this.read();
  }

  mutate(operation) {
    const job = this.queue.then(async () => {
      const records = await this.read();
      const result = operation(records);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(records, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  create(input) {
    const data = validateDecision(input);
    return this.mutate(records => {
      const now = new Date().toISOString();
      const record = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
      records.push(record);
      return record;
    });
  }

  update(id, input, partial = true) {
    const data = validateDecision(input, partial);
    return this.mutate(records => {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) throw Object.assign(new Error('Decision not found'), { status: 404 });
      records[index] = { ...records[index], ...data, updatedAt: new Date().toISOString() };
      return records[index];
    });
  }

  delete(id) {
    return this.mutate(records => {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) throw Object.assign(new Error('Decision not found'), { status: 404 });
      records.splice(index, 1);
    });
  }
}

module.exports = { DecisionStore };
