const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WorkspaceValidationService } = require('./workspace-validation-service');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const LAUNCHER = `const {createServer}=require('/workspace/src/app.js');
const server=createServer(); server.listen('/runtime/app.sock');`;

class GeneratedAppRuntimeService {
  constructor({ projectRepository, runRepository, workspaceService, runtimeRoot = path.join(__dirname, '../../.cache/generated-runtime'), startupMs = 10000, spawnProcess = spawn, flutterExecutable = null, deviceDiscovery = null }) {
    Object.assign(this, { projectRepository, runRepository, workspaceService, runtimeRoot, startupMs, spawnProcess, flutterExecutable, deviceDiscovery });
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
      startedAt: entry.startedAt, status: entry.status, targetPlatform: entry.targetPlatform || 'web',
      deviceId: entry.device?.id || null, deviceName: entry.device?.name || null,
      url: entry.status === 'running' && entry.port ? `http://127.0.0.1:${entry.port}` : null } :
      { projectId: id, pid: null, port: null, startedAt: null, status: 'stopped', targetPlatform: null, deviceId: null, deviceName: null, url: null };
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
    const targetPlatform = project.targetPlatform === 'mobile' ? 'mobile' : 'web';
    try {
      const root = this.workspaceService.workspaceRoot;
      if (await fs.realpath(root) !== root) throw Error();
      const expected = path.join(root, id);
      if ((await fs.lstat(expected)).isSymbolicLink() || await fs.realpath(expected) !== expected) throw Error();
      workspace = await this.workspaceService.getWorkspacePath(id);
      if (workspace !== expected) throw Error();
      await new WorkspaceValidationService({ workspaceService: this.workspaceService }).inspect(workspace, targetPlatform);
    } catch { throw fail('Unsafe workspace or unsupported start configuration.'); }
    const entry = { status: 'starting', startedAt: new Date().toISOString() };
    entry.targetPlatform = targetPlatform;
    this.registry.set(id, entry);
    try {
      if (targetPlatform === 'mobile') return await this.startFlutter(id, workspace, entry);
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
      entry.child = this.spawnProcess('/usr/bin/bwrap', ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv', ...mounts,
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
    } catch (error) {
      await this.cleanup(id, entry);
      if (error?.status) throw error;
      throw fail('App startup failed. Check the application contract and local Bubblewrap availability.', 503);
    }
  }); }
  async flutterPath() {
    if (this.flutterExecutable) return path.resolve(this.flutterExecutable);
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
      const candidate = path.join(directory, 'flutter');
      try { await fs.access(candidate, require('node:fs').constants.X_OK); return await fs.realpath(candidate); } catch { /* Continue through configured PATH. */ }
    }
    throw fail('Flutter CLI is not installed or not available in the Factory server PATH.', 503);
  }
  async flutterDevices(flutter) {
    if (this.deviceDiscovery) return this.deviceDiscovery(flutter);
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(flutter, ['devices', '--machine'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let stdout = ''; let stderr = ''; let settled = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Flutter device discovery timed out.')); }, 10000);
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.once('error', error => finish(error));
      child.once('close', code => {
        if (code !== 0) return finish(new Error(stderr.trim() || `flutter devices exited with code ${code}.`));
        try { const parsed = JSON.parse(stdout); finish(null, Array.isArray(parsed) ? parsed : parsed.devices || []); }
        catch { finish(new Error('Flutter device discovery returned invalid machine-readable output.')); }
      });
    });
  }
  async startFlutter(id, workspace, entry) {
    const flutter = await this.flutterPath();
    let devices;
    try { devices = await this.flutterDevices(flutter); }
    catch (error) { throw fail(`Could not inspect Flutter devices: ${error.message}`, 503); }
    const android = devices.filter(device => {
      const platform = String(device.targetPlatform || device.platform || '').toLowerCase();
      return device.isAndroid === true || device.isAndroidDevice === true || platform.startsWith('android') || platform === 'android';
    }).sort((a, b) => Number(Boolean(b.emulator || b.isEmulator || b['is emulator'])) - Number(Boolean(a.emulator || a.isEmulator || a['is emulator'])));
    if (!android.length) throw fail('No Android device or emulator is available. Start an Android emulator and try again.', 409);
    entry.device = { id: String(android[0].id), name: String(android[0].name || android[0].id) };
    if (!entry.device.id || entry.device.id === 'undefined') throw fail('Flutter reported an Android device without a usable device ID.', 503);
    const child = this.spawnProcess(flutter, ['run', '-d', entry.device.id], { cwd: workspace, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    entry.child = child;
    entry.output = '';
    const capture = chunk => { entry.output = (entry.output + chunk.toString()).slice(-8192); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    entry.closed = new Promise(resolve => {
      child.once('error', error => { entry.exited = true; entry.startError = error; resolve(); });
      child.once('close', (code, signal) => { entry.exited = true; entry.exitCode = code; entry.exitSignal = signal; resolve(); });
    });
    entry.closed.then(() => { if (entry.status === 'running') this.cleanup(id, entry).catch(() => {}); });
    await new Promise((resolve, reject) => {
      if (child.pid) resolve();
      else { child.once('spawn', resolve); child.once('error', reject); }
    }).catch(error => { throw fail(`Could not start Flutter: ${error.message}`, 503); });
    // Let immediate executable/device failures surface before presenting the app as running.
    await new Promise(resolve => setTimeout(resolve, Math.min(350, this.startupMs)));
    if (entry.exited) throw fail(`Flutter launch failed${entry.output ? `: ${entry.output.trim().slice(-1500)}` : '.'}`, 503);
    entry.status = 'running';
    return this.snapshot(id);
  }
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
      if (entry.child && !entry.exited) {
        if (entry.targetPlatform === 'mobile') {
          entry.child.kill('SIGINT');
          const graceful = await Promise.race([entry.closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
          if (!graceful && !entry.exited) { entry.child.kill('SIGTERM'); const terminated = await Promise.race([entry.closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]); if (!terminated && !entry.exited) { entry.child.kill('SIGKILL'); await entry.closed; } }
        } else { entry.child.kill('SIGKILL'); await entry.closed; }
      }
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
