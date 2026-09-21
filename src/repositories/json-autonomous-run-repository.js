const { JsonProjectRepository } = require('./json-project-repository');
// Reuse the serialized, atomic JSON collection persistence contract.
class JsonAutonomousRunRepository extends JsonProjectRepository {}
module.exports = { JsonAutonomousRunRepository };
