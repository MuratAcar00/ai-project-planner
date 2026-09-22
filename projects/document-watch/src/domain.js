'use strict';

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function validateDocument(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'A document object is required.');
  }
  const limits = { title: 200, owner: 120, expiryDate: 10, category: 100, notes: 2000 };
  if (!Object.keys(input).length || Object.keys(input).some(key => !Object.hasOwn(limits, key))) {
    throw new AppError(400, 'Provide supported document fields only.');
  }
  const result = {};
  for (const [key, limit] of Object.entries(limits)) {
    const required = ['title', 'owner', 'expiryDate'].includes(key);
    if (!Object.hasOwn(input, key)) {
      if (partial) continue;
      if (required) throw new AppError(400, `${key} is required.`);
      result[key] = '';
      continue;
    }
    if (typeof input[key] !== 'string' || input[key].length > limit || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input[key])) {
      throw new AppError(400, `${key} must be text of at most ${limit} characters.`);
    }
    result[key] = input[key].trim();
    if (required && !result[key]) throw new AppError(400, `${key} is required.`);
    if (key === 'expiryDate' && !validDate(result[key])) throw new AppError(400, 'expiryDate must be a valid YYYY-MM-DD date.');
  }
  return result;
}

function filterDocuments(documents, params, today = new Date().toISOString().slice(0, 10)) {
  const allowed = ['owner', 'from', 'to', 'withinDays'];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new AppError(400, 'Unsupported or repeated filter.');
  }
  let from = params.get('from');
  let to = params.get('to');
  for (const value of [from, to]) {
    if (value !== null && !validDate(value)) throw new AppError(400, 'Date filters must use YYYY-MM-DD.');
  }
  if (params.has('withinDays')) {
    const days = params.get('withinDays');
    if (!/^\d{1,4}$/.test(days) || Number(days) > 3650 || from || to) throw new AppError(400, 'withinDays must be 0–3650 and cannot be combined with from/to.');
    from = today;
    to = new Date(Date.parse(today) + Number(days) * 86400000).toISOString().slice(0, 10);
  }
  if (from && to && from > to) throw new AppError(400, 'from must not follow to.');
  const owner = params.get('owner');
  if (owner !== null && (!owner.trim() || owner.length > 120)) throw new AppError(400, 'Invalid owner filter.');
  return documents.filter(doc => (!from || doc.expiryDate >= from) && (!to || doc.expiryDate <= to)
    && (owner === null || doc.owner.toLowerCase() === owner.trim().toLowerCase()))
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.id.localeCompare(b.id));
}

module.exports = { AppError, validateDocument, filterDocuments };
