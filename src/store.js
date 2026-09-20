const { JsonProjectRepository } = require('./repositories/json-project-repository');

class ProjectStore extends JsonProjectRepository {}
module.exports = { ProjectStore };
