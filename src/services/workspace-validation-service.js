const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FLUTTER_CACHE_INFRASTRUCTURE = /read-only file system|(?:^|\b)EROFS\b|engine\.stamp(?:\.tmp[^\s:]*)?|engine\.realm|flutter.{0,100}(?:sdk )?(?:cache|bootstrap|startup).{0,100}(?:permission denied|read-only|failed|error)|(?:sdk )?(?:cache|bootstrap|startup).{0,100}flutter.{0,100}(?:permission denied|read-only|failed|error)/i;
const FLUTTER_TOOLCHAIN_DISCOVERY_INFRASTRUCTURE = /failed to find\s+\\?["']?(?:which|java|javac)\\?["']?\s+in (?:the )?search path|(?:unable to locate|could not find|failed to locate)\s+(?:a\s+)?(?:java|jdk|jre)(?:\s+(?:runtime|development kit|installation|executable))?|(?:java|jdk|jre)\s+(?:runtime|installation|executable).{0,60}(?:not found|unavailable|could not be found)/i;
const JAVA_SECURITY_CONFIGURATION_INFRASTRUCTURE = /(?:java\.lang\.)?InternalError:?\s*Error loading java\.security file|(?:error|failed|unable) (?:loading|to load|opening|reading).{0,80}(?:java\.security|java\.policy|nss\.cfg)|(?:java\.security|java\.policy|nss\.cfg).{0,100}(?:not found|no such file|permission denied|read-only file system)/i;
const GRADLE_DISTRIBUTION_URL = /^https:\/\/services\.gradle\.org\/distributions\/(gradle-(\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]+)?)-(bin|all)\.zip)$/;
const GRADLE_WRAPPER_CACHE_INFRASTRUCTURE = /does not contain any directories\. Expected to find exactly 1 directory/i;
const inside = (root, candidate) => candidate.startsWith(`${root}${path.sep}`);

async function inspectFlutterCache(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Flutter SDK cache contains a symbolic link.');
    const stat = await fs.lstat(target);
    if (entry.isDirectory()) {
      await fs.chmod(target, stat.mode | 0o700);
      await inspectFlutterCache(target);
    } else if (entry.isFile()) await fs.chmod(target, stat.mode | 0o600);
    else throw new Error('Flutter SDK cache contains an unsupported file type.');
  }
}

async function inspectGradleDistribution(directory, makeWritable = false) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Trusted Gradle distribution contains a symbolic link.');
    const stat = await fs.lstat(target);
    if (entry.isDirectory()) {
      if (makeWritable) await fs.chmod(target, stat.mode | 0o700);
      await inspectGradleDistribution(target, makeWritable);
    } else if (!entry.isFile()) throw new Error('Trusted Gradle distribution contains an unsupported file type.');
  }
}

// No shell, network, host home, credentials or host writable mounts. Generated
// tests are executable code, so cwd and command allowlisting alone are not a sandbox.
class SandboxValidationRunner {
  constructor({ spawnProcess = spawn, timeoutMs = 120000, outputLimit = 16384, flutterExecutable = null, gradleCacheRoot = path.join(process.env.HOME || '/nonexistent', '.gradle', 'wrapper', 'dists') } = {}) {
    Object.assign(this, { spawnProcess, timeoutMs, outputLimit, flutterExecutable, gradleCacheRoot });
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
  async flutterToolchainAliases() {
    const aliases = [];
    for (const name of ['which', 'java']) {
      const commandPath = path.join('/usr/bin', name);
      const alternativePath = path.join('/etc/alternatives', name);
      try {
        const [commandTarget, alternativeTarget] = await Promise.all([fs.realpath(commandPath), fs.realpath(alternativePath)]);
        if (commandTarget !== alternativeTarget || !inside('/usr', alternativeTarget)) continue;
        const info = await fs.stat(alternativeTarget);
        if (!info.isFile()) continue;
        await fs.access(alternativeTarget, require('node:fs').constants.X_OK);
        aliases.push({ name, target: alternativeTarget, destination: alternativePath });
      } catch { /* The sandbox only needs aliases actually used by this host. */ }
    }
    return aliases;
  }
  async flutterJavaSecurityConfigDirectories(javaExecutable) {
    if (!javaExecutable) return [];
    try {
      const binary = await fs.realpath(javaExecutable);
      const javaHome = path.dirname(path.dirname(binary));
      const directories = new Set();
      for (const name of ['java.security', 'java.policy', 'nss.cfg']) {
        try {
          const file = await fs.realpath(path.join(javaHome, 'conf', 'security', name));
          if ((await fs.stat(file)).isFile() && inside('/etc', path.dirname(file))) directories.add(path.dirname(file));
        } catch { /* Optional JDK security configuration file. */ }
      }
      return [...directories];
    } catch { return []; }
  }
  async prepareFlutterCache(workspace) {
    const flutterPath = await this.resolveFlutterExecutable();
    if (!flutterPath) throw new Error('Flutter CLI is not installed or not available in the configured server PATH.');
    const flutterRoot = path.basename(path.dirname(flutterPath)) === 'bin' ? path.dirname(path.dirname(flutterPath)) : path.dirname(flutterPath);
    const source = path.join(flutterRoot, 'bin', 'cache');
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Flutter SDK cache is missing or unsafe.');
    const validationRoot = await fs.realpath(path.join(workspace, '.validation'));
    if (!inside(await fs.realpath(workspace), validationRoot)) throw new Error('Flutter validation cache root is outside the workspace.');
    const cachePath = await fs.mkdtemp(path.join(validationRoot, 'flutter-bin-cache-'));
    try {
      await fs.cp(source, cachePath, { recursive: true, dereference: false, preserveTimestamps: true });
      await inspectFlutterCache(cachePath);
      return { path: await fs.realpath(cachePath), flutterRoot };
    } catch (error) {
      await fs.rm(cachePath, { recursive: true, force: true });
      throw error;
    }
  }
  async cleanupFlutterCache(workspace, cache) {
    if (!cache?.path) return;
    const validationRoot = await fs.realpath(path.join(workspace, '.validation'));
    const cachePath = await fs.realpath(cache.path);
    if (!inside(validationRoot, cachePath) || path.basename(cachePath).indexOf('flutter-bin-cache-') !== 0) throw new Error('Refusing to remove a Flutter cache outside the validation workspace.');
    await fs.rm(cachePath, { recursive: true, force: true });
  }
  async prepareGradleDistribution(workspace) {
    const workspaceRoot = await fs.realpath(workspace);
    const propertiesPath = path.join(workspaceRoot, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    const properties = await fs.readFile(propertiesPath, 'utf8');
    const values = properties.split(/\r?\n/).filter(line => line && !/^\s*[#!]/.test(line)).map(line => {
      const separator = line.search(/[=:]/);
      return separator < 0 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }).filter(Boolean);
    const urls = values.filter(([key]) => key === 'distributionUrl').map(([, value]) => value.replace(/\\([\\:=#! ])/g, '$1'));
    if (urls.length !== 1) throw new Error('Gradle wrapper must declare exactly one distribution URL.');
    const match = GRADLE_DISTRIBUTION_URL.exec(urls[0]);
    if (!match) throw new Error('Gradle wrapper distribution URL is unsupported or unsafe.');
    const [, archiveName, version, distributionType] = match;
    const cacheRoot = await fs.realpath(this.gradleCacheRoot);
    const distributionDir = `gradle-${version}-${distributionType}`;
    const trustedDistributionDir = path.join(cacheRoot, distributionDir);
    let distributionInfo;
    try { distributionInfo = await fs.lstat(trustedDistributionDir); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Trusted offline Gradle distribution ${archiveName} is unavailable.`); throw error; }
    if (!distributionInfo.isDirectory() || distributionInfo.isSymbolicLink()) throw new Error(`Trusted offline Gradle distribution ${archiveName} is unavailable or unsafe.`);
    let entries;
    try { entries = await fs.readdir(trustedDistributionDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Trusted offline Gradle distribution ${archiveName} is unavailable.`); throw error; }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9]+$/.test(entry.name)) continue;
      const candidateRoot = path.join(trustedDistributionDir, entry.name);
      const extractedRoot = path.join(candidateRoot, `gradle-${version}`);
      try {
        const [hashInfo, archiveInfo, extractedInfo] = await Promise.all([
          fs.lstat(candidateRoot), fs.lstat(path.join(candidateRoot, archiveName)), fs.lstat(extractedRoot)
        ]);
        if (hashInfo.isDirectory() && !hashInfo.isSymbolicLink() && archiveInfo.isFile() && !archiveInfo.isSymbolicLink() &&
            extractedInfo.isDirectory() && !extractedInfo.isSymbolicLink()) candidates.push({ hash: entry.name, archive: path.join(candidateRoot, archiveName), extracted: extractedRoot });
      } catch { /* Cache entry does not contain this exact archive. */ }
    }
    if (candidates.length !== 1) throw new Error(`Trusted offline Gradle distribution ${archiveName} is unavailable or ambiguous.`);
    const selected = candidates[0];
    const markerSource = `${selected.archive}.ok`;
    if (!(await fs.lstat(markerSource).then(info => info.isFile() && !info.isSymbolicLink(), () => false))) throw new Error(`Trusted offline Gradle distribution ${archiveName} has no completion marker.`);
    await inspectGradleDistribution(selected.extracted);
    const privateGradleRoot = path.join(workspaceRoot, '.validation', 'gradle');
    const privateGradleReal = await fs.realpath(privateGradleRoot);
    if (!inside(workspaceRoot, privateGradleReal) || !(await fs.stat(privateGradleReal)).isDirectory()) throw new Error('Private Gradle cache is outside the validation workspace.');
    const target = path.join(privateGradleReal, 'wrapper', 'dists', distributionDir, selected.hash);
    const existing = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error('Private Gradle wrapper cache path is unsafe.');
    if (existing) await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const archiveTarget = path.join(target, archiveName);
    try {
      await fs.copyFile(selected.archive, archiveTarget);
      await fs.chmod(archiveTarget, 0o600);
      await fs.writeFile(`${archiveTarget}.ok`, '', { mode: 0o600 });
      const extractedTarget = path.join(target, `gradle-${version}`);
      await fs.cp(selected.extracted, extractedTarget, { recursive: true, dereference: false, preserveTimestamps: true });
      await fs.chmod(extractedTarget, (await fs.stat(extractedTarget)).mode | 0o700);
      await inspectGradleDistribution(extractedTarget, true);
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    return { version, distribution: archiveName, hash: selected.hash, path: target };
  }
  async run(workspace, command, args, { flutterCachePath = null, gradleDistributionPath = null } = {}) {
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
      if (!flutterCachePath) return { passed: false, infrastructureError: true, error: 'Flutter validation requires a private SDK cache.' };
      const workspaceRoot = await fs.realpath(workspace);
      const privateCache = await fs.realpath(flutterCachePath);
      if (!inside(workspaceRoot, privateCache) || !(await fs.stat(privateCache)).isDirectory()) return { passed: false, infrastructureError: true, error: 'Flutter SDK cache is outside the controlled workspace.' };
      const javaHome = process.env.JAVA_HOME && path.isAbsolute(process.env.JAVA_HOME) ? process.env.JAVA_HOME : null;
      const androidHome = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].find(value => value && path.isAbsolute(value)) || null;
      const pubCache = process.env.PUB_CACHE && path.isAbsolute(process.env.PUB_CACHE) ? process.env.PUB_CACHE : path.join(process.env.HOME || '/nonexistent', '.pub-cache');
      const readonly = [flutterRoot, javaHome, androidHome, pubCache, '/usr', '/bin', '/lib', '/lib64'];
      for (const directory of [...new Set(readonly.filter(Boolean))]) {
        try { if ((await fs.stat(directory)).isDirectory()) mounts.push('--ro-bind', directory, directory); } catch { /* Optional toolchain/cache directory. */ }
      }
      const aliases = await this.flutterToolchainAliases();
      let javaExecutable = javaHome && path.join(javaHome, 'bin', 'java');
      if (!javaExecutable) {
        javaExecutable = aliases.find(alias => alias.name === 'java')?.target;
        if (!javaExecutable) try { javaExecutable = await fs.realpath('/usr/bin/java'); } catch { /* Java may be unavailable. */ }
      }
      const securityDirectories = await this.flutterJavaSecurityConfigDirectories(javaExecutable);
      if (securityDirectories.length) {
        // Bind only JDK security configuration directories under /etc. Stage
        // each read-only source before creating the sandbox's private /etc.
        mounts.push('--dir', '/run');
        securityDirectories.forEach((directory, index) => {
          const stagedPath = `/run/autonomous-jdk-security-${index}`;
          mounts.push('--dir', stagedPath, '--ro-bind', directory, stagedPath);
        });
        mounts.push('--chmod', '0555', '/run');
      }
      if (aliases.length || securityDirectories.length) {
        // Recreate only required toolchain links. Host /etc stays unmounted.
        mounts.push('--dir', '/etc');
        if (aliases.length) {
          mounts.push('--dir', '/etc/alternatives');
          for (const alias of aliases) mounts.push('--symlink', alias.target, alias.destination);
          mounts.push('--chmod', '0555', '/etc/alternatives');
        }
        securityDirectories.forEach((directory, index) => {
          const parent = path.dirname(directory);
          const parentSegments = path.relative('/etc', parent).split(path.sep).filter(Boolean);
          let destination = '/etc';
          for (const segment of parentSegments) {
            destination = path.join(destination, segment);
            mounts.push('--dir', destination);
          }
          const stagedPath = `/run/autonomous-jdk-security-${index}`;
          mounts.push('--symlink', stagedPath, directory);
          for (let current = parent; current !== '/etc'; current = path.dirname(current)) mounts.push('--chmod', '0555', current);
        });
        mounts.push('--chmod', '0555', '/etc');
      }
      mounts.push('--bind', privateCache, path.join(flutterRoot, 'bin', 'cache'));
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
    let cache;
    let outcome = { passed: false, infrastructureError: false, checks };
    let cleanupError;
    try {
      if (this.runner.prepareFlutterCache) cache = await this.runner.prepareFlutterCache(workspace);
      let testResult;
      try { testResult = await this.runner.run(workspace, 'flutter', ['test'], { flutterCachePath: cache?.path || null }); }
      catch (error) { testResult = { passed: false, infrastructureError: true, error: String(error.message || error).slice(0, 1000) }; }
      const testEvidence = `${testResult.output || ''}\n${testResult.error || ''}`;
      if (!testResult.passed && (FLUTTER_CACHE_INFRASTRUCTURE.test(testEvidence) || FLUTTER_TOOLCHAIN_DISCOVERY_INFRASTRUCTURE.test(testEvidence) || JAVA_SECURITY_CONFIGURATION_INFRASTRUCTURE.test(testEvidence) || /(?:flutter|dart|gradle|android sdk|java|toolchain).{0,80}(?:not found|not installed|unavailable|could not be started|failed to start|unable to locate|not configured|permission denied|no such file)|(?:unable to locate|could not find).{0,80}(?:android sdk|flutter|java)|licenses? (?:not accepted|not been accepted)|failed to (?:download|downloaded) (?:the )?gradle(?: distribution)?|(?:UnknownHostException|unknown host).{0,100}services\.gradle\.org|could not (?:resolve host|get resource)|connection timed out|could not start gradle|unable to start the daemon process|could not determine java version/i.test(testEvidence))) testResult.infrastructureError = true;
      if (testResult.passed && /(?:no tests ran|no tests found)/i.test(testResult.output || '')) { testResult.passed = false; testResult.error = 'Flutter test command did not run any tests.'; }
      checks.push({ name: 'flutter-test', ...testResult });
      if (!testResult.passed) {
        outcome = { passed: false, infrastructureError: Boolean(testResult.infrastructureError), checks };
      } else {
        outcome = { passed: true, infrastructureError: false, checks, artifactStatus: { androidApk: { status: 'not-built' } } };
        let gradleDistribution = null;
        try {
          if (typeof this.runner.prepareGradleDistribution !== 'function') throw new Error('Trusted offline Gradle distribution provider is unavailable.');
          gradleDistribution = await this.runner.prepareGradleDistribution(workspace);
        } catch (error) {
          const message = String(error.message || error).slice(0, 1000);
          checks.push({ name: 'android-debug-apk', passed: false, infrastructureError: true, error: message, output: message });
          outcome.artifactStatus.androidApk = { status: 'infrastructure-unavailable', message };
        }
        if (gradleDistribution) {
          let apkResult;
          try { apkResult = await this.runner.run(workspace, 'flutter', ['build', 'apk', '--debug'], { flutterCachePath: cache?.path || null, gradleDistributionPath: gradleDistribution.path }); }
          catch (error) { apkResult = { passed: false, infrastructureError: true, error: String(error.message || error).slice(0, 1000) }; }
          const evidence = `${apkResult.output || ''}\n${apkResult.error || ''}`;
          if (!apkResult.passed && (FLUTTER_CACHE_INFRASTRUCTURE.test(evidence) || FLUTTER_TOOLCHAIN_DISCOVERY_INFRASTRUCTURE.test(evidence) || JAVA_SECURITY_CONFIGURATION_INFRASTRUCTURE.test(evidence) || GRADLE_WRAPPER_CACHE_INFRASTRUCTURE.test(evidence))) apkResult.infrastructureError = true;
          if (!apkResult.passed && !apkResult.infrastructureError && /(?:android sdk|java|jdk|gradle).{0,80}(?:not found|not installed|unavailable|could not be started|failed to start|unable to locate|not configured|permission denied|no such file)|licenses? (?:not accepted|not been accepted)|failed to (?:download|downloaded) (?:the )?gradle(?: distribution)?|(?:UnknownHostException|unknown host).{0,100}services\.gradle\.org|could not (?:resolve host|get resource)|connection timed out|could not start gradle|unable to start the daemon process|could not determine java version/i.test(evidence)) apkResult.infrastructureError = true;
          checks.push({ name: 'android-debug-apk', ...apkResult });
          outcome.artifactStatus.androidApk = { status: apkResult.passed ? 'built' : apkResult.infrastructureError ? 'infrastructure-unavailable' : 'build-failed', ...(apkResult.error ? { message: String(apkResult.error).slice(0, 1000) } : {}) };
        }
      }
    } catch (error) {
      const message = String(error.message || error).slice(0, 1000);
      checks.push({ name: 'flutter-sdk-cache', passed: false, infrastructureError: true, error: message });
      outcome = { passed: false, infrastructureError: true, checks };
    } finally {
      if (cache && this.runner.cleanupFlutterCache) {
        try { await this.runner.cleanupFlutterCache(workspace, cache); }
        catch (error) { cleanupError = String(error.message || error).slice(0, 1000); }
      }
    }
    if (cleanupError) {
      checks.push({ name: 'flutter-sdk-cache-cleanup', passed: false, infrastructureError: true, error: cleanupError });
      if (outcome.passed) return { ...outcome, passed: false, infrastructureError: true };
      return { passed: false, infrastructureError: true, checks };
    }
    return outcome;
  }
}
module.exports = { WorkspaceValidationService, SandboxValidationRunner };
