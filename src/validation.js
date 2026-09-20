const PLATFORMS = ['Web', 'Mobile', 'Desktop', 'API / Backend'];
const TECHNOLOGIES = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'Other'];
const EXPERIENCE_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];
const { TASK_STATUSES } = require('./domain');

function validateProjectInput(input = {}) {
  const errors = {};
  const project = {};

  for (const field of ['name', 'description']) {
    const value = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!value) errors[field] = `${field === 'name' ? 'Project name' : 'Project description'} is required.`;
    else if (value.length > (field === 'name' ? 100 : 2000)) errors[field] = `${field === 'name' ? 'Project name' : 'Project description'} is too long.`;
    else project[field] = value;
  }

  const choices = [
    ['platform', PLATFORMS],
    ['technology', TECHNOLOGIES],
    ['experienceLevel', EXPERIENCE_LEVELS]
  ];
  for (const [field, allowed] of choices) {
    if (!allowed.includes(input[field])) errors[field] = `Choose a valid ${field === 'experienceLevel' ? 'experience level' : field}.`;
    else project[field] = input[field];
  }
  return { valid: Object.keys(errors).length === 0, errors, project };
}

function validateTaskUpdate(input = {}) {
  const errors = {};
  const update = {};
  if (typeof input.completed === 'boolean') update.completed = input.completed;
  else if (input.completed !== undefined) errors.completed = 'completed must be a boolean.';
  if (input.status !== undefined) {
    if (!TASK_STATUSES.includes(input.status)) errors.status = `status must be one of: ${TASK_STATUSES.join(', ')}.`;
    else update.status = input.status;
  }
  if (update.completed !== undefined && update.status !== undefined && update.completed !== (update.status === 'completed')) {
    errors.status = 'status and completed must describe the same completion state.';
  }
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'string' || !input.priority.trim() || input.priority.length > 50) errors.priority = 'priority must be a non-empty string up to 50 characters.';
    else update.priority = input.priority.trim();
  }
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies) || input.dependencies.some(id => typeof id !== 'string' || !id.trim()) || input.dependencies.length > 100) errors.dependencies = 'dependencies must be an array of up to 100 task IDs.';
    else update.dependencies = [...new Set(input.dependencies.map(id => id.trim()))];
  }
  if (input.acceptanceCriteria !== undefined) {
    if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 500) || input.acceptanceCriteria.length > 100) errors.acceptanceCriteria = 'acceptanceCriteria must be an array of up to 100 non-empty strings.';
    else update.acceptanceCriteria = input.acceptanceCriteria.map(item => item.trim());
  }
  if (!Object.keys(update).length && !Object.keys(errors).length) errors.body = 'Provide at least one supported task field.';
  return { valid: !Object.keys(errors).length, errors, update };
}

module.exports = { validateProjectInput, validateTaskUpdate, PLATFORMS, TECHNOLOGIES, EXPERIENCE_LEVELS, TASK_STATUSES };
