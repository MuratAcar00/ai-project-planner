const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, digest, markerName, projectSlug, safeDirectory, inspectWorkspace, readRegular } = require('./project-publish-files');
const { ProjectPublishGit, WEB_ROOT, oid } = require('./project-publish-git');
const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

class GeneratedProjectPublisher {
  constructor({ projectRepository, runRepository, workspaceService, runtimeService, repositoryRoot = REPOSITORY_ROOT, git } = {}) {
    Object.assign(this, { projectRepository, runRepository, workspaceService, runtimeService, repositoryRoot });
    this.git = git || new ProjectPublishGit({ repositoryRoot });
    this.active = new Set();
  }
  async project(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw fail('Invalid project ID.', 400);
    const project = await this.projectRepository.get(id);
    if (!project) throw fail('Project not found.', 404);
    const run = project.autonomousRunId && await this.runRepository.get(project.autonomousRunId);
    if (!run || run.projectId !== id) throw fail('Publishing requires an autonomous project.');
    return { project, run };
  }
  eligible(project, run) {
    if (project.status !== 'Completed' || run.state !== 'completed' || run.validationPassed !== true || run.validationResults?.at(-1)?.passed !== true || run.needsAttention || project.needsAttention || project.runs?.some(r => ['running', 'queued'].includes(r.status))) throw fail('Only completed, successfully validated autonomous projects can be published.');
    if (this.runtimeService && this.runtimeService.snapshot(project.id).status !== 'stopped') throw fail('Stop this app before publishing its workspace.');
  }
  async status(id) {
    const { project, run } = await this.project(id);
    const meta = project.publishing || {};
    const valid = /^[a-z0-9][a-z0-9-]{0,79}$/.test(meta.publishedSlug || '') && oid(meta.commitHash);
    const published = meta.publishStatus === 'published' && valid;
    let eligible = true;
    try { this.eligible(project, run); } catch { eligible = false; }
    return { projectId: id, publishStatus: this.active.has(id) ? 'publishing' : published ? 'published' : meta.publishStatus === 'needs_attention' || meta.publishStatus === 'publishing' ? 'needs_attention' : 'not_published',
      canPublish: eligible && !published && !this.active.has(id), publishedSlug: valid ? meta.publishedSlug : null,
      publishedAt: published && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(meta.publishedAt || '') ? meta.publishedAt : null,
      commitHash: valid ? meta.commitHash : null, githubUrl: published ? WEB_ROOT + meta.publishedSlug : null,
      message: published ? 'Published successfully.' : meta.publishStatus === 'needs_attention' || meta.publishStatus === 'publishing' ? 'Needs Attention: publishing did not finish. Review the workspace and Git access before retrying.' : null };
  }
  async metadata(id, update) {
    const result = await this.projectRepository.update(id, project => {
      project.publishing = { ...project.publishing, ...update };
      return true;
    });
    if (!result) throw fail('Project disappeared while publishing.');
  }
  async inspect(id) {
    const { project, run } = await this.project(id);
    this.eligible(project, run);
    const slug = projectSlug(project.name);
    const workspaceRoot = this.workspaceService.workspaceRoot;
    await safeDirectory(workspaceRoot);
    const workspace = path.join(workspaceRoot, id);
    if (path.dirname(workspace) !== workspaceRoot) throw fail('Unsafe workspace path.');
    await safeDirectory(workspace);
    const inspection = await inspectWorkspace(workspace);
    const files = inspection.files;
    files.push({ relative: markerName, buffer: Buffer.from(JSON.stringify({ version: 1, projectId: id, runId: run.id, slug }, null, 2) + '\n') });
    const manifest = files.map(file => ({ path: file.relative, sha256: digest(file.buffer) }));
    return { project, slug, files, manifest, excluded: inspection.excluded };
  }
  async dryRun(id) {
    const inspected = await this.inspect(id);
    await this.git.preflight();
    await this.checkDestination(inspected);
    return { projectId: id, slug: inspected.slug, destination: `projects/${inspected.slug}/`, files: inspected.manifest.map(file => file.path), excluded: inspected.excluded, secretScan: 'passed' };
  }
  async checkDestination({ project, slug, files }) {
    await safeDirectory(this.repositoryRoot);
    const root = path.join(this.repositoryRoot, 'projects');
    try { await safeDirectory(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = path.join(root, slug);
    let exists = true;
    try { await safeDirectory(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    const other = (await this.projectRepository.list()).some(p => p.id !== project.id && p.publishing?.publishedSlug === slug);
    if (other) throw fail('Another project already owns this slug.');
    if (exists) {
      if (!project.publishing?.manifest || project.publishing.publishedSlug !== slug) throw fail('Project slug already exists; it will not be overwritten.');
      const expected = new Map(files.map(file => [file.relative, file.buffer]));
      let count = 0;
      async function visit(directory) {
        await safeDirectory(directory);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) throw fail('Unsafe published directory symlink.');
          if (entry.isDirectory()) await visit(target);
          else {
            const relative = path.relative(destination, target).split(path.sep).join('/');
            if (!expected.has(relative) || !(await readRegular(target)).equals(expected.get(relative))) throw fail('Existing project files differ; operator review is required.');
            count++;
          }
        }
      }
      await visit(destination);
      if (count !== expected.size) throw fail('Existing project files are incomplete.');
    }
    return { root, destination, exists };
  }
  async copy(inspection) {
    const { root, destination, exists } = await this.checkDestination(inspection);
    if (exists) return;
    await fs.mkdir(root, { recursive: true });
    await safeDirectory(root);
    const staging = await fs.mkdtemp(path.join(root, '.publish-'));
    try {
      for (const file of inspection.files) {
        const target = path.join(staging, file.relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await safeDirectory(path.dirname(target));
        await fs.writeFile(target, file.buffer, { flag: 'wx', mode: 0o644 });
      }
      // mkdir reserves the name without overwriting a concurrent destination.
      await fs.mkdir(destination);
      try {
        await safeDirectory(destination);
        for (const name of await fs.readdir(staging)) await fs.rename(path.join(staging, name), path.join(destination, name));
      } catch (error) { throw fail('Project copy was interrupted; inspect the reserved project directory before retrying.'); }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  async publish(id) {
    await this.project(id);
    if (this.active.size) throw fail('Another project publish is in progress.');
    this.active.add(id);
    let lock;
    let temporary;
    const lockPath = path.join(this.repositoryRoot, '.git', 'factory-publish.lock');
    try {
      await this.git.preflight();
      try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') throw fail('Publishing is locked by another operation. If interrupted, a trusted operator must review the lock.');
        throw error;
      }
      const current = await this.project(id);
      this.eligible(current.project, current.run);
      if (current.project.publishing?.publishStatus === 'published') {
        this.active.delete(id);
        return await this.status(id);
      }
      const inspection = await this.inspect(id);
      const { project, slug, files, manifest } = inspection;
      const prefix = `projects/${slug}/`;
      const prior = project.publishing || {};
      if (prior.manifest && JSON.stringify(prior.manifest) !== JSON.stringify(manifest)) throw fail('Workspace changed since publishing started. Operator review is required.');
      await this.checkDestination(inspection);
      const remoteHead = await this.git.remoteHead();
      let remoteCommit = prior.commitHash;
      let localCommit = prior.localCommitHash;
      let localParent = prior.localParent;
      const message = `feat(project): publish ${project.name}`;
      temporary = await fs.mkdtemp(path.join(this.repositoryRoot, '.git', 'factory-publish-'));
      if (remoteCommit) {
        await this.git.verifyCommit(remoteCommit, prior.remoteParent, prefix, files);
        // A failed push may actually have reached GitHub. Reconcile before any
        // retry so no second commit is created. Divergence requires review.
        if (remoteHead !== remoteCommit && remoteHead !== prior.remoteParent) throw fail('Remote main changed. Review the pending publication; no retry was made.');
      } else {
        remoteCommit = await this.git.createCommit(remoteHead, prefix, files, message, path.join(temporary, 'remote-index'));
        localParent = await this.git.git(['rev-parse', 'HEAD']);
        localCommit = await this.git.createCommit(localParent, prefix, files, message, path.join(temporary, 'local-index'));
        await this.metadata(id, { publishStatus: 'publishing', publishedSlug: slug, manifest, commitHash: remoteCommit, remoteParent: remoteHead, localCommitHash: localCommit, localParent });
      }
      await this.copy({ ...inspection, project: (await this.project(id)).project });
      const head = await this.git.git(['rev-parse', 'HEAD']);
      await this.git.verifyCommit(localCommit, localParent, prefix, files);
      if (head === localParent) await this.git.attachLocal(localCommit, localParent, prefix, files);
      else if (head !== localCommit) throw fail('Local main changed during publication. Operator review is required.');
      const refreshed = await this.project(id);
      this.eligible(refreshed.project, refreshed.run);
      if (remoteHead !== remoteCommit) await this.git.push(remoteCommit);
      await this.metadata(id, { publishStatus: 'published', publishedAt: new Date().toISOString() });
    } catch (error) {
      if (lock) await this.metadata(id, { publishStatus: 'needs_attention' });
      if (error.safePublishError) throw error;
      throw fail('Needs Attention: publishing could not finish safely. Review repository and workspace permissions.', 500);
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      if (lock) { await lock.close(); await fs.unlink(lockPath); }
      this.active.delete(id);
    }
    return this.status(id);
  }
}
module.exports = { GeneratedProjectPublisher };
