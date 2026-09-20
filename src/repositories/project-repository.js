class ProjectRepository {
  async list() { throw new Error('ProjectRepository.list must be implemented.'); }
  async get() { throw new Error('ProjectRepository.get must be implemented.'); }
  async create() { throw new Error('ProjectRepository.create must be implemented.'); }
  async update() { throw new Error('ProjectRepository.update must be implemented.'); }
  async delete() { throw new Error('ProjectRepository.delete must be implemented.'); }
}

module.exports = { ProjectRepository };
