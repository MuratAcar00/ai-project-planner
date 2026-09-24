const { JsonProjectRepository } = require('./json-project-repository');

// Sessions share the existing serialized, atomic JSON persistence implementation.
class JsonFactorySessionRepository extends JsonProjectRepository {}
module.exports = { JsonFactorySessionRepository };
