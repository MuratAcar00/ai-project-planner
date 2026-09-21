const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectRepository } = require('./project-repository');

class JsonProjectRepository extends ProjectRepository {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.pending = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try { await fs.access(this.filePath); } catch { await this.write([]); }
  }

  async read() {
    await this.init();
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Project data file contains invalid JSON.');
      throw error;
    }
  }

  async write(projects) {
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(projects, null, 2));
    await fs.rename(temporary, this.filePath);
  }

  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async list() { return this.serialize(() => this.read()); }
  async get(id) { return (await this.list()).find(project => project.id === id) || null; }

  async create(project) {
    return this.serialize(() => this.createStored(project));
  }

  async createStored(project) {
    const projects = await this.read();
    projects.unshift(project);
    await this.write(projects);
    return project;
  }

  async update(id, updateFn) {
    return this.serialize(() => this.updateStored(id, updateFn));
  }

  async updateStored(id, updateFn) {
    const projects = await this.read();
    const index = projects.findIndex(project => project.id === id);
    if (index < 0) return null;
    const result = updateFn(projects[index]);
    if (!result) return false;
    await this.write(projects);
    return projects[index];
  }

  async delete(id) {
    return this.serialize(() => this.deleteStored(id));
  }

  async deleteStored(id) {
    const projects = await this.read();
    const remaining = projects.filter(project => project.id !== id);
    if (remaining.length === projects.length) return false;
    await this.write(remaining);
    return true;
  }
}

module.exports = { JsonProjectRepository };
