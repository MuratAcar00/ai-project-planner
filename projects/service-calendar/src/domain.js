'use strict';

const { randomUUID } = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validate(input, kind, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  const fields = kind === 'equipment'
    ? { name: 'text', location: 'optional', notes: 'optional', intervalDays: 'interval', nextServiceDate: 'date' }
    : { date: 'date', description: 'text', technician: 'optional' };
  const result = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) throw new HttpError(400, `Unknown field: ${key}`);
  }
  for (const [key, type] of Object.entries(fields)) {
    if (!Object.hasOwn(input, key)) {
      if (partial) continue;
      if (type === 'optional') { result[key] = ''; continue; }
      throw new HttpError(400, `${key} is required`);
    }
    const value = input[key];
    if (type === 'interval') {
      if (!Number.isInteger(value) || value < 1 || value > 3650) {
        throw new HttpError(400, 'intervalDays must be an integer from 1 to 3650');
      }
    } else {
      const limit = key === 'notes' || key === 'description' ? 2000 : 200;
      if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
        throw new HttpError(400, `${key} must be text of at most ${limit} characters`);
      }
      if (type !== 'optional' && !value.trim()) throw new HttpError(400, `${key} cannot be empty`);
      if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '9989-12-31')) {
        throw new HttpError(400, `${key} must be a valid YYYY-MM-DD date between 1900 and 9989`);
      }
    }
    result[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (partial && !Object.keys(result).length) throw new HttpError(400, 'Provide at least one field');
  return result;
}

function createRecord(input, kind) {
  return { id: randomUUID(), ...validate(input, kind), createdAt: new Date().toISOString() };
}

function equipmentView(equipment, services, today = new Date().toISOString().slice(0, 10)) {
  const history = services.filter((service) => service.equipmentId === equipment.id);
  const lastServiceDate = history.reduce((latest, service) => service.date > latest ? service.date : latest, '');
  let dueDate = equipment.nextServiceDate;
  if (lastServiceDate) {
    const date = new Date(`${lastServiceDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + equipment.intervalDays);
    dueDate = date.toISOString().slice(0, 10);
  }
  return { ...equipment, lastServiceDate: lastServiceDate || null, dueDate, status: dueDate < today ? 'overdue' : dueDate === today ? 'due' : 'scheduled' };
}

module.exports = { HttpError, validate, createRecord, equipmentView };
