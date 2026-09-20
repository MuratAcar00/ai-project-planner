const PLATFORMS = ['Web', 'Mobile', 'Desktop', 'API / Backend'];
const TECHNOLOGIES = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'Other'];
const EXPERIENCE_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];

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

module.exports = { validateProjectInput, PLATFORMS, TECHNOLOGIES, EXPERIENCE_LEVELS };
