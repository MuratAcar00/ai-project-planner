const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const FLUTTER_ARGS = projectId => ['create', '--platforms=android,ios', '--project-name', projectId.replace(/-/g, '_'), '.'];

class FlutterWorkspaceScaffolder {
  constructor({ workspaceService, projectRepository, runCommand = execFileAsync, timeoutMs = 120000, maxBuffer = 1024 * 1024 } = {}) {
    Object.assign(this, { workspaceService, projectRepository, runCommand, timeoutMs, maxBuffer });
  }

  async prepare(project, runId) {
    if (project.targetPlatform !== 'mobile') return { prepared: true, skipped: true };
    const stored = await this.projectRepository.get(project.id);
    if (stored.flutterScaffold?.status === 'completed') return { prepared: true, skipped: true };
    if (stored.flutterScaffold?.status && stored.flutterScaffold.status !== 'completed') {
      return { prepared: false, infrastructureError: true, error: 'Flutter scaffold was already attempted but did not reach a completion checkpoint; refusing to run it again.' };
    }

    let workspacePath;
    try { workspacePath = await this.workspaceService.getWorkspacePath(project.id); }
    catch (error) { return { prepared: false, infrastructureError: true, error: String(error.message || error).slice(0, 1500) }; }
    await this.projectRepository.update(project.id, current => {
      if (current.targetPlatform !== 'mobile') throw new Error('Flutter scaffold target changed during setup.');
      if (current.flutterScaffold?.status) throw new Error('Flutter scaffold checkpoint changed during setup.');
      current.flutterScaffold = { status: 'attempted', runId, startedAt: new Date().toISOString() };
      return true;
    });
    try {
      await this.runCommand('flutter', FLUTTER_ARGS(project.id), { cwd: workspacePath, shell: false, windowsHide: true, timeout: this.timeoutMs, maxBuffer: this.maxBuffer });
    } catch (error) {
      const message = String(error.stderr || error.message || 'Flutter scaffold command failed.').slice(0, 1500);
      await this.projectRepository.update(project.id, current => {
        current.flutterScaffold = { ...current.flutterScaffold, status: 'failed', error: message, completedAt: new Date().toISOString() };
        return true;
      });
      return { prepared: false, infrastructureError: true, error: message };
    }
    await this.projectRepository.update(project.id, current => {
      current.flutterScaffold = { ...current.flutterScaffold, status: 'completed', completedAt: new Date().toISOString() };
      return true;
    });
    return { prepared: true, skipped: false };
  }
}

module.exports = { FlutterWorkspaceScaffolder, FLUTTER_ARGS };
