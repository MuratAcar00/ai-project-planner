const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// No shell, network, host home, credentials or host writable mounts. Generated
// tests are executable code, so cwd and command allowlisting alone are not a sandbox.
class SandboxValidationRunner {
  constructor({ spawnProcess = spawn, timeoutMs = 120000, outputLimit = 16384, flutterExecutable = null } = {}) {
    Object.assign(this, { spawnProcess, timeoutMs, outputLimit, flutterExecutable });
  }
  resolveFlutterExecutable() {
    if (this.flutterExecutable) return path.resolve(this.flutterExecutable);
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
      const candidate = path.join(directory, 'flutter');
      try { if (require('node:fs').statSync(candidate).isFile() && require('node:fs').accessSync(candidate, require('node:fs').constants.X_OK) === undefined) return fs.realpath(candidate); }
      catch { /* Continue through the server-configured PATH. */ }
    }
    return null;
  }
  async run(workspace, command, args) {
    if (!['node', 'npm', 'flutter'].includes(command)) throw new Error('Unsupported validation command.');
    if (command === 'flutter' && !((args.length === 1 && args[0] === 'test') || (args.length === 3 && args[0] === 'build' && args[1] === 'apk' && args[2] === '--debug'))) throw new Error('Unsupported Flutter validation command.');
    const mounts = [];
    let executable = `/usr/bin/${command}`;
    let validationPath = '/usr/bin:/bin';
    let flutterEnvironment = [];
    if (command === 'flutter') {
      const flutterPath = await this.resolveFlutterExecutable();
      if (!flutterPath) return { passed: false, infrastructureError: true, error: 'Flutter CLI is not installed or not available in the configured server PATH.' };
      const flutterRoot = path.basename(path.dirname(flutterPath)) === 'bin' ? path.dirname(path.dirname(flutterPath)) : path.dirname(flutterPath);
      const javaHome = process.env.JAVA_HOME && path.isAbsolute(process.env.JAVA_HOME) ? process.env.JAVA_HOME : null;
      const androidHome = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].find(value => value && path.isAbsolute(value)) || null;
      const pubCache = process.env.PUB_CACHE && path.isAbsolute(process.env.PUB_CACHE) ? process.env.PUB_CACHE : path.join(process.env.HOME || '/nonexistent', '.pub-cache');
      const readonly = [flutterRoot, javaHome, androidHome, pubCache, '/usr', '/bin', '/lib', '/lib64'];
      for (const directory of [...new Set(readonly.filter(Boolean))]) {
        try { if ((await fs.stat(directory)).isDirectory()) mounts.push('--ro-bind', directory, directory); } catch { /* Optional toolchain/cache directory. */ }
      }
      executable = flutterPath;
      validationPath = ['/usr/bin', '/bin', javaHome && path.join(javaHome, 'bin'), path.join(flutterRoot, 'bin'), androidHome && path.join(androidHome, 'platform-tools'), androidHome && path.join(androidHome, 'cmdline-tools', 'latest', 'bin')].filter(Boolean).join(':');
      flutterEnvironment = [...(javaHome ? ['--setenv', 'JAVA_HOME', javaHome] : []), '--setenv', 'ANDROID_HOME', androidHome || '/nonexistent', '--setenv', 'ANDROID_SDK_ROOT', androidHome || '/nonexistent'];
    } else for (const directory of ['/usr', '/bin', '/lib', '/lib64']) {
      try { await fs.access(directory); mounts.push('--ro-bind', directory, directory); } catch { /* Optional system directory. */ }
    }
    const sandboxArgs = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv', ...mounts,
      '--proc', '/proc', '--dev', '/dev', '--bind', workspace, '/workspace', '--chdir', '/workspace',
      '--setenv', 'PATH', validationPath, '--setenv', 'HOME', '/workspace/.validation/home',
      '--setenv', 'TMPDIR', '/workspace/.validation/tmp', '--setenv', 'PUB_CACHE', command === 'flutter' ? (process.env.PUB_CACHE && path.isAbsolute(process.env.PUB_CACHE) ? process.env.PUB_CACHE : path.join(process.env.HOME || '/nonexistent', '.pub-cache')) : '/workspace/.validation/pub-cache', '--setenv', 'GRADLE_USER_HOME', '/workspace/.validation/gradle', '--setenv', 'ANDROID_USER_HOME', '/workspace/.validation/android', ...flutterEnvironment, '--setenv', 'NODE_ENV', 'test',
      '--', executable, ...args];
    return new Promise(resolve => {
      let child;
      let output = '';
      let settled = false;
      let timedOut = false;
      let deadline;
      let drain;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(drain);
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        resolve({ ...result, output, timedOut });
      };
      try { child = this.spawnProcess('/usr/bin/bwrap', sandboxArgs, { cwd: workspace, shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { finish({ passed: false, infrastructureError: true, error: 'Validation sandbox could not start.' }); return; }
      const append = chunk => { if (!settled) output += String(chunk).slice(0, Math.max(0, this.outputLimit - output.length)); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const stop = () => { try { child.kill('SIGKILL'); } catch { /* Result still bounded. */ } };
      for (const stream of [child.stdout, child.stderr]) stream.on('error', () => { stop(); finish({ passed: false, infrastructureError: true, error: 'Sandbox stream failed.' }); });
      child.once('error', () => finish({ passed: false, infrastructureError: true, error: 'Bubblewrap is unavailable.' }));
      child.once('exit', () => {
        clearTimeout(deadline);
        drain = setTimeout(() => { stop(); finish({ passed: false, error: 'Sandbox output did not close.' }); }, 1000);
      });
      child.once('close', (exitCode, signal) => finish({ passed: exitCode === 0 && !timedOut, exitCode, signal,
        infrastructureError: exitCode !== 0 && /bwrap:/.test(output) }));
      deadline = setTimeout(() => { timedOut = true; stop(); finish({ passed: false, error: 'Validation timed out.' }); }, this.timeoutMs);
    });
  }
}

const HEALTH_SCRIPT = `const {createServer}=require('./src/app');
(async()=>{const server=createServer(); let timer=setTimeout(()=>process.exit(1),10000);
try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/health');
if(res.status!==200 || (await res.json()).status!=='ok')throw Error('Health check failed');
console.log('health: ok');}catch(error){console.error(error.message);process.exitCode=1}
finally{clearTimeout(timer);server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}})();`;

class WorkspaceValidationService {
  constructor({ workspaceService, projectRepository = null, runner = new SandboxValidationRunner() }) { Object.assign(this, { workspaceService, projectRepository, runner }); }
  async inspect(workspace, targetPlatform = 'web') {
    const files = [];
    const visit = async (directory, depth = 0) => {
      if (depth > 12) throw new Error('Workspace exceeds validation depth limit.');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        const relative = JSON.stringify(path.relative(workspace, target));
        if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in autonomous validation: ${relative}`);
        // Only the empty root metadata directory is safe without reading Git content.
        // Git files (including worktree pointers), nested and populated metadata fail closed.
        if (entry.name.toLowerCase() === '.git') {
          if (depth === 0 && entry.name === '.git' && entry.isDirectory() && !(await fs.readdir(target)).length) continue;
          throw Object.assign(new Error(`Git metadata requires operator review: ${relative}`), { infrastructureError: true });
        }
        if (/^(\.env(?:\..*)?|\.npmrc|secrets?|credentials?)(?:$|[._-])/i.test(entry.name) || /\.(pem|key|p12|pfx)$/i.test(entry.name) || /^(?:id_(rsa|ed25519|ecdsa|dsa)|private[-_]?key)(?:$|[._-])/i.test(entry.name)) throw new Error(`Sensitive or configuration files are not allowed in validation workspace: ${relative}`);
        if (entry.name === '.validation' || (targetPlatform === 'mobile' && ['.dart_tool', 'build', '.gradle'].includes(entry.name))) continue;
        if (entry.isDirectory()) await visit(target, depth + 1);
        else if (entry.isFile()) {
          if (files.length >= 300 || (await fs.stat(target)).size > 1024 * 1024) throw new Error('Workspace exceeds validation size limit.');
          files.push(path.relative(workspace, target));
        } else throw new Error('Only regular workspace files are allowed.');
      }
    };
    await visit(workspace);
    if (targetPlatform === 'mobile') {
      const required = ['pubspec.yaml', 'lib/main.dart', 'android', 'ios/Runner.xcodeproj/project.pbxproj'];
      for (const relative of required) if (!files.includes(relative) && !(await fs.stat(path.join(workspace, relative)).then(info => info.isDirectory()).catch(() => false))) throw new Error(`Missing required Flutter project entry: ${relative}`);
      const tests = files.filter(file => /^test\/[a-zA-Z0-9_-]+_test\.dart$/.test(file));
      if (!tests.length) throw new Error('At least one Flutter test file is required.');
      return { files, testFiles: tests };
    }
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces']) {
      if (manifest[key] && Object.keys(manifest[key]).length) throw new Error('Autonomous MVP validation requires zero dependencies.');
    }
    const allowed = { start: 'node src/server.js', test: 'node --test test/*.test.js', build: 'node --check src/server.js' };
    if (manifest.scripts?.start !== allowed.start || manifest.scripts?.test !== allowed.test ||
        Object.entries(manifest.scripts).some(([key, value]) => allowed[key] !== value)) throw new Error('Package scripts must match the fixed autonomous contract.');
    if (manifest.type && manifest.type !== 'commonjs') throw new Error('Autonomous MVP must use CommonJS.');
    if (!files.includes('src/server.js') || !files.includes('src/app.js') || !files.includes('public/index.html')) throw new Error('Missing required application entry points.');
    const testFiles = files.filter(file => /^test\/[a-zA-Z0-9_-]+\.test\.js$/.test(file));
    if (!testFiles.length) throw new Error('At least one automated test file is required.');
    // Existing npm metadata must not introduce dependencies or nonlocal resolution.
    if (files.includes('package-lock.json')) {
      const lock = JSON.parse(await fs.readFile(path.join(workspace, 'package-lock.json'), 'utf8'));
      if (Object.keys(lock.packages || {}).some(key => key !== '') || Object.keys(lock.dependencies || {}).length) throw new Error('Lockfile contains dependencies.');
    }
    return { files, testFiles };
  }
  async validate(context) {
    try { return await this.validateWorkspace(context); }
    catch (error) {
      return { passed: false, infrastructureError: true, checks: [{ name: 'validation-infrastructure', passed: false, infrastructureError: true, error: 'Validation infrastructure could not complete.', code: error.code || 'VALIDATOR_ERROR' }] };
    }
  }
  async validateWorkspace({ projectId }) {
    const checks = [];
    const workspace = await this.workspaceService.getWorkspacePath(projectId);
    const project = this.projectRepository ? await this.projectRepository.get(projectId) : null;
    const targetPlatform = project?.targetPlatform === 'mobile' ? 'mobile' : 'web';
    if (targetPlatform === 'mobile') return this.validateFlutterWorkspace(workspace);
    let inspection;
    try { inspection = await this.inspect(workspace, targetPlatform); }
    catch (error) {
      const infrastructureError = Boolean(error.infrastructureError || ['EACCES', 'EPERM', 'EIO'].includes(error.code));
      return { passed: false, infrastructureError, checks: [{ name: 'contract', passed: false, error: error.message, infrastructureError }] };
    }
    for (const relative of ['.validation', '.validation/home', '.validation/tmp', '.validation/npm-cache']) {
      const target = path.join(workspace, relative);
      await fs.mkdir(target, { recursive: true });
      if ((await fs.lstat(target)).isSymbolicLink() || !(await fs.realpath(target)).startsWith(`${workspace}${path.sep}`)) throw new Error('Unsafe validation directory.');
    }
    const emptyGlobal = path.join(workspace, '.validation', 'empty-global.npmrc');
    try { await fs.writeFile(emptyGlobal, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const globalInfo = await fs.lstat(emptyGlobal);
    if (!globalInfo.isFile() || globalInfo.isSymbolicLink() || globalInfo.size !== 0) throw new Error('Unsafe validation npm configuration.');
    const commands = [
      ['install', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/workspace/.validation/npm-cache', '--userconfig=/dev/null', '--globalconfig=/workspace/.validation/empty-global.npmrc']],
      ...inspection.files.filter(file => /^(src|public|test)\/.*\.js$/.test(file)).map(file => [`syntax:${file}`, 'node', ['--check', file]]),
      ['tests', 'node', ['--test', ...inspection.testFiles]],
      ['startup-health', 'node', ['-e', HEALTH_SCRIPT]]
    ];
    for (const [name, command, args] of commands) {
      const result = await this.runner.run(workspace, command, args);
      if (!result.passed && /double-loading config|Exit prior to config file resolving/i.test(result.output || '')) result.infrastructureError = true;
      const passedTests = Number((result.output || '').match(/^# pass (\d+)\s*$/m)?.[1] || 0);
      if (name === 'tests' && result.passed && !passedTests) {
        result.passed = false;
        result.error = 'Test command must report at least one passing test (not only skipped tests).';
      }
      checks.push({ name, ...result });
      if (!result.passed) return { passed: false, infrastructureError: Boolean(result.infrastructureError), checks };
    }
    return { passed: true, checks };
  }
  async validateFlutterWorkspace(workspace) {
    const checks = [];
    let inspection;
    try { inspection = await this.inspect(workspace, 'mobile'); }
    catch (error) {
      const infrastructureError = Boolean(error.infrastructureError || ['EACCES', 'EPERM', 'EIO'].includes(error.code));
      return { passed: false, infrastructureError, checks: [{ name: 'flutter-contract', passed: false, error: error.message, infrastructureError }] };
    }
    for (const relative of ['.validation', '.validation/home', '.validation/tmp', '.validation/pub-cache', '.validation/gradle', '.validation/android']) {
      const target = path.join(workspace, relative);
      await fs.mkdir(target, { recursive: true });
      if ((await fs.lstat(target)).isSymbolicLink() || !(await fs.realpath(target)).startsWith(`${workspace}${path.sep}`)) return { passed: false, infrastructureError: true, checks: [{ name: 'flutter-contract', passed: false, error: 'Unsafe Flutter validation directory.', infrastructureError: true }] };
    }
    for (const [name, args] of [['flutter-test', ['test']], ['android-debug-apk', ['build', 'apk', '--debug']]]) {
      let result;
      try { result = await this.runner.run(workspace, 'flutter', args); }
      catch (error) { result = { passed: false, infrastructureError: true, error: String(error.message || error).slice(0, 1000) }; }
      if (!result.passed && !result.infrastructureError && /(?:flutter|dart|gradle|android sdk|java|toolchain).{0,80}(?:not found|not installed|unavailable|could not be started|failed to start|unable to locate|not configured|permission denied|no such file)|(?:unable to locate|could not find).{0,80}(?:android sdk|flutter|java)|licenses? (?:not accepted|not been accepted)|failed to download (?:gradle|gradle distribution)|could not (?:resolve host|get resource)|connection timed out|could not start gradle|unable to start the daemon process|could not determine java version/i.test(result.output || result.error || '')) result.infrastructureError = true;
      if (name === 'flutter-test' && result.passed && /(?:no tests ran|no tests found)/i.test(result.output || '')) { result.passed = false; result.error = 'Flutter test command did not run any tests.'; }
      checks.push({ name, ...result });
      if (!result.passed) return { passed: false, infrastructureError: Boolean(result.infrastructureError), checks };
    }
    return { passed: true, checks };
  }
}
module.exports = { WorkspaceValidationService, SandboxValidationRunner };
