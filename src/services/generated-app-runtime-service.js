const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WorkspaceValidationService } = require('./workspace-validation-service');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const LAUNCHER = `const {createServer}=require('/workspace/src/app.js');
const server=createServer(); server.listen('/runtime/app.sock');`;

class GeneratedAppRuntimeService {
  constructor({ projectRepository, runRepository, workspaceService, runtimeRoot = path.join(__dirname, '../../.cache/generated-runtime'), startupMs = 10000 }) {
    Object.assign(this, { projectRepository, runRepository, workspaceService, runtimeRoot, startupMs });
    this.registry = new Map();
    this.locks = new Map();
  }
  async project(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw fail('Invalid project ID.', 400);
    const project = await this.projectRepository.get(id);
    if (!project) throw fail('Project not found.', 404);
    const run = project.autonomousRunId && await this.runRepository.get(project.autonomousRunId);
    if (!run || run.projectId !== id) throw fail('Runtime requires an autonomous project.');
    return { project, run };
  }
  snapshot(id) {
    const entry = this.registry.get(id);
    return entry ? { projectId: id, pid: entry.child?.pid || null, port: entry.port || null,
      startedAt: entry.startedAt, status: entry.status,
      url: entry.status === 'running' ? `http://127.0.0.1:${entry.port}` : null } :
      { projectId: id, pid: null, port: null, startedAt: null, status: 'stopped', url: null };
  }
  async status(id) { await this.project(id); return this.snapshot(id); }
  exclusive(id, work) {
    if (this.locks.has(id)) throw fail('Runtime operation already in progress.');
    const promise = Promise.resolve().then(work).finally(() => this.locks.delete(id));
    this.locks.set(id, promise);
    return promise;
  }
  start(id) { return this.exclusive(id, async () => {
    const { project, run } = await this.project(id);
    if (project.status !== 'Completed' || run.state !== 'completed') throw fail('Only completed autonomous projects can start.');
    if (this.registry.has(id)) throw fail('App is already started.');
    let workspace;
    try {
      const root = this.workspaceService.workspaceRoot;
      if (await fs.realpath(root) !== root) throw Error();
      const expected = path.join(root, id);
      if ((await fs.lstat(expected)).isSymbolicLink() || await fs.realpath(expected) !== expected) throw Error();
      workspace = await this.workspaceService.getWorkspacePath(id);
      if (workspace !== expected) throw Error();
      await new WorkspaceValidationService({ workspaceService: this.workspaceService }).inspect(workspace);
    } catch { throw fail('Unsafe workspace or unsupported start configuration.'); }
    const entry = { status: 'starting', startedAt: new Date().toISOString() };
    this.registry.set(id, entry);
    try {
      await fs.mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
      if (await fs.realpath(this.runtimeRoot) !== this.runtimeRoot) throw Error();
      entry.directory = await fs.mkdtemp(path.join(this.runtimeRoot, 'app-'));
      const socketPath = path.join(entry.directory, 'app.sock');
      // Keep the host port bound throughout startup. The generated process has no
      // host network; a loopback-only HTTP proxy reaches its private Unix socket.
      entry.proxy = http.createServer((req, res) => {
        const upstream = http.request({ socketPath, path: req.url, method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
        });
        upstream.setTimeout(30000, () => upstream.destroy());
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('App unavailable.'); });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      });
      await new Promise((resolve, reject) => { entry.proxy.once('error', reject); entry.proxy.listen(0, '127.0.0.1', resolve); });
      entry.port = entry.proxy.address().port;
      const mounts = [];
      for (const directory of ['/usr', '/bin', '/lib', '/lib64']) {
        try { await fs.access(directory); mounts.push('--ro-bind', directory, directory); } catch { /* Optional system mount. */ }
      }
      entry.child = spawn('/usr/bin/bwrap', ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv', ...mounts,
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', workspace, '/workspace',
        '--bind', entry.directory, '/runtime', '--chdir', '/workspace', '--setenv', 'NODE_ENV', 'production',
        '--setenv', 'HOME', '/tmp', '--', '/usr/bin/node', '-e', LAUNCHER],
      { shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
      entry.closed = new Promise(resolve => {
        entry.child.once('error', () => { entry.exited = true; resolve(); });
        entry.child.once('close', () => { entry.exited = true; resolve(); });
      });
      entry.closed.then(() => { if (entry.status === 'running') this.cleanup(id, entry).catch(() => {}); });
      const deadline = Date.now() + this.startupMs;
      let healthy = false;
      while (!entry.exited && Date.now() < deadline) {
        healthy = await this.probe(entry.port);
        if (healthy) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!healthy || entry.exited) throw Error();
      entry.status = 'running';
      return this.snapshot(id);
    } catch {
      await this.cleanup(id, entry);
      throw fail('App startup failed. Check the application contract and local Bubblewrap availability.', 503);
    }
  }); }
  async probe(port) {
    try {
      let response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500), redirect: 'manual' });
      if (response.status === 404) {
        await response.body?.cancel();
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500), redirect: 'manual' });
      }
      const healthy = response.ok;
      await response.body?.cancel();
      return healthy;
    } catch { return false; }
  }
  async cleanup(id, entry) {
    if (entry.cleanup) return entry.cleanup;
    entry.status = 'stopping';
    entry.cleanup = (async () => {
      if (entry.proxy) { entry.proxy.closeAllConnections(); await new Promise(resolve => entry.proxy.close(resolve)); }
      if (entry.child && !entry.exited) { entry.child.kill('SIGKILL'); await entry.closed; }
      if (entry.directory) await fs.rm(entry.directory, { recursive: true, force: true });
      if (this.registry.get(id) === entry) this.registry.delete(id);
    })();
    return entry.cleanup;
  }
  stop(id) { return this.exclusive(id, async () => {
    await this.project(id);
    const entry = this.registry.get(id);
    if (entry) await this.cleanup(id, entry);
    return this.snapshot(id);
  }); }
  async close() {
    await Promise.allSettled([...this.locks.values()]);
    await Promise.all([...this.registry].map(([id, entry]) => this.cleanup(id, entry)));
  }
}
module.exports = { GeneratedAppRuntimeService };
