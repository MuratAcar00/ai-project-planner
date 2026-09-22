'use strict';

class ValidationError extends Error {}

const fields = ['title', 'context', 'decision', 'alternatives', 'tags', 'reviewDate'];

function string(value, name, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ValidationError(`${name} must be ${required ? 'a non-empty' : 'a'} string of at most ${max} characters`);
  }
  return value.trim();
}

function validateDecision(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Expected a JSON object');
  }
  if (Object.keys(input).some(key => !fields.includes(key))) {
    throw new ValidationError('Unknown decision field');
  }
  if (partial && !Object.keys(input).length) throw new ValidationError('Provide at least one field');
  const result = {};
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) {
      if (partial) continue;
      if (key === 'title' || key === 'decision') throw new ValidationError(`${key} is required`);
      result[key] = key === 'tags' || key === 'alternatives' ? [] : key === 'reviewDate' ? null : '';
      continue;
    }
    const value = input[key];
    if (key === 'tags' || key === 'alternatives') {
      const maxItems = key === 'tags' ? 20 : 30;
      if (!Array.isArray(value) || value.length > maxItems) {
        throw new ValidationError(`${key} must be an array of at most ${maxItems} strings`);
      }
      result[key] = [...new Set(value.map(item => string(item, key, key === 'tags' ? 50 : 2000, true)))];
    } else if (key === 'reviewDate') {
      result[key] = validateDate(value, true);
    } else {
      result[key] = string(value, key, key === 'title' ? 200 : 10000, key !== 'context');
    }
  }
  return result;
}

function validateDate(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Expected a valid date in YYYY-MM-DD format');
  }
  return value;
}

module.exports = { ValidationError, validateDecision, validateDate };
