const fs = require('node:fs/promises');
const path = require('node:path');

class ProjectStore {
  constructor(filePath) { this.filePath = filePath; }
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
  async write(projects) { await fs.writeFile(this.filePath, JSON.stringify(projects, null, 2)); }
  async list() { return this.read(); }
  async get(id) { return (await this.read()).find(project => project.id === id) || null; }
  async create(project) { const projects = await this.read(); projects.unshift(project); await this.write(projects); return project; }
  async update(id, updateFn) { const projects = await this.read(); const index = projects.findIndex(p => p.id === id); if (index < 0) return null; const result = updateFn(projects[index]); if (!result) return false; await this.write(projects); return projects[index]; }
  async delete(id) { const projects = await this.read(); const remaining = projects.filter(p => p.id !== id); if (remaining.length === projects.length) return false; await this.write(remaining); return true; }
}
module.exports = { ProjectStore };
