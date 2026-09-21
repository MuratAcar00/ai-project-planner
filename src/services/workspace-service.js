const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

class WorkspaceService {
  constructor({ workspaceRoot = process.env.PROJECT_WORKSPACE_ROOT || path.join(__dirname, '..', '..', 'workspaces') } = {}) {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('PROJECT_WORKSPACE_ROOT must be an absolute path.');
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async getWorkspacePath(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('Project ID is not valid for workspace resolution.');
    }

    await fs.mkdir(this.workspaceRoot, { recursive: true });
    const root = await fs.realpath(this.workspaceRoot);
    const candidate = path.resolve(root, projectId);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Project workspace must remain inside the workspace root.');
    await fs.mkdir(candidate, { recursive: true });
    const workspace = await fs.realpath(candidate);
    const details = await fs.stat(workspace);
    if (!workspace.startsWith(`${root}${path.sep}`) || !details.isDirectory()) {
      throw new Error('Project workspace must be an existing directory inside the workspace root.');
    }
    return workspace;
  }
}

module.exports = { WorkspaceService };
