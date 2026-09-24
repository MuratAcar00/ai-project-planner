const { makeId } = require('../domain');
const { runSummary } = require('../autonomous/presentation');

const finished = status => ['stopped', 'completed'].includes(status);
const terminal = run => ['completed', 'failed', 'abandoned'].includes(run.state);
const fail = (message, status = 409) => Object.assign(new Error(message), { status, safeSessionError: true });
function validateSessionConfig(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['maxProjects', 'stopOnNeedsAttention', 'autoPublish'].includes(key))) throw fail('Only maxProjects, stopOnNeedsAttention and autoPublish are supported.', 400);
  const config = { maxProjects: input.maxProjects ?? 5, stopOnNeedsAttention: input.stopOnNeedsAttention ?? true, autoPublish: input.autoPublish ?? false };
  if (!Number.isInteger(config.maxProjects) || config.maxProjects < 1 || config.maxProjects > 10) throw fail('maxProjects must be an integer from 1 to 10.', 400);
  for (const key of ['stopOnNeedsAttention', 'autoPublish']) if (typeof config[key] !== 'boolean' || input[key] === null) throw fail(`${key} must be boolean.`, 400);
  if (input.maxProjects === null) throw fail('maxProjects must be an integer from 1 to 10.', 400);
  return config;
}

// A single-process coordinator: it never plans, executes tasks or repairs applications.
// Every entry goes through the existing pipeline with a durable idempotency key.
class AutonomousModeService {
  constructor({ sessionRepository, autonomousService, projectRepository, publisher, executionService, pollMs = 1000 }) {
    Object.assign(this, { sessionRepository, autonomousService, projectRepository, publisher, executionService, pollMs });
    this.control = Promise.resolve();
    this.initialization = null;
    this.timer = null;
    this.closed = false;
    this.publishJob = null;
  }
  serialize(operation) {
    const promise = this.control.then(operation);
    this.control = promise.catch(() => {});
    return promise;
  }
  initialize() {
    if (!this.initialization) this.initialization = this.serialize(async () => {
      await this.autonomousService.initialize();
      const sessions = (await this.sessionRepository.list()).filter(item => !finished(item.status));
      if (sessions.length > 1) {
        for (const session of sessions) await this.attention(session.id, 'Multiple unfinished sessions require operator review.');
        return;
      }
      const session = sessions[0];
      if (!session) return;
      const run = await this.currentRun(session);
      if (session.projects.length && !run) return this.attention(session.id, 'Interrupted project reservation requires operator review.');
      if (run && !await this.owns(session, run)) return this.attention(session.id, 'Session/run ownership could not be reconciled.');
      if (session.projects.at(-1)?.publishStatus === 'publishing') return this.attention(session.id, 'Publishing was interrupted. Review publication before resuming.');
      if (run) await this.recordRun(session.id, run);
      if (session.status === 'stopping') {
        if (!run || terminal(run) || run.state === 'paused') return this.patch(session.id, { status: 'stopped', completedAt: new Date().toISOString() });
        return this.attention(session.id, 'Interrupted stop requires operator review.');
      }
      // Restart never launches execution or publishing. Explicit Resume is required.
      if (session.status === 'needs_attention' || (run && (run.needsAttention || run.state === 'failed' || !['paused', 'completed'].includes(run.state)))) {
        return this.attention(session.id, 'Review the current run after restart before resuming.');
      }
      await this.patch(session.id, { status: 'paused', lastError: null });
    });
    return this.initialization;
  }
  async patch(id, values) {
    return this.sessionRepository.update(id, session => {
      Object.assign(session, values, { updatedAt: new Date().toISOString() });
      return true;
    });
  }
  attention(id, message) { return this.patch(id, { status: 'needs_attention', lastError: message }); }
  async active() { return (await this.sessionRepository.list()).find(item => !finished(item.status)); }
  async currentRun(session) {
    if (session.currentRunId) return this.autonomousService.runRepository.get(session.currentRunId);
    const slot = session.projects.at(-1);
    if (!slot) return null;
    return (await this.autonomousService.runRepository.list()).find(run => run.config?.requestId === slot.requestId) || null;
  }
  async owns(session, run) {
    const slot = session.projects.at(-1);
    if (!slot || run.config?.requestId !== slot.requestId || (slot.runId && slot.runId !== run.id)) return false;
    if (run.projectId) {
      const project = await this.projectRepository.get(run.projectId);
      if (!project || project.autonomousRunId !== run.id) return false;
    }
    return true;
  }
  async recordRun(id, run) {
    return this.sessionRepository.update(id, session => {
      const slot = session.projects.at(-1);
      Object.assign(slot, { runId: run.id, projectId: run.projectId || null, status: run.state });
      session.currentRunId = run.id;
      session.currentProjectId = run.projectId || null;
      session.completedProjects = session.projects.filter(item => item.status === 'completed').length;
      session.failedProjects = session.projects.filter(item => item.status === 'failed').length;
      session.updatedAt = new Date().toISOString();
      return true;
    });
  }
  schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch(() => this.serialize(async () => {
        const session = await this.active();
        if (session) await this.attention(session.id, 'Session coordination failed. Operator review required.');
      })).catch(() => { /* Persistent storage unavailable: stop scheduling and require restart review. */ });
    }, this.pollMs);
    this.timer.unref?.();
  }
  async start(input) {
    const config = validateSessionConfig(input);
    await this.initialize();
    return this.serialize(async () => {
      if (this.closed || await this.active()) throw fail('An Autonomous Mode session is already active or the server is stopping.');
      if ((await this.autonomousService.runRepository.list()).some(run => !terminal(run)) || this.autonomousService.jobs.size || this.executionService?.jobs?.size) throw fail('Finish or review the existing autonomous run first.');
      const now = new Date().toISOString();
      const session = { id: makeId('session'), status: 'running', createdAt: now, startedAt: now, updatedAt: now, completedAt: null,
        ...config, completedProjects: 0, failedProjects: 0, currentRunId: null, currentProjectId: null, lastError: null, projects: [] };
      await this.sessionRepository.create(session);
      this.schedule();
      return session;
    });
  }
  async manualStart(input) {
    await this.initialize();
    return this.serialize(async () => {
      if (this.closed || await this.active()) throw fail('Autonomous Mode owns the build pipeline. Pause/stop controls are in its panel.');
      return this.autonomousService.start(input);
    });
  }
  async manualTask(operation) {
    await this.initialize();
    return this.serialize(async () => {
      if (this.closed || await this.active()) throw fail('Autonomous Mode owns the execution pipeline.');
      return operation();
    });
  }
  async manualControl(id, action) {
    await this.initialize();
    return this.serialize(async () => {
      if (await this.active()) throw fail('Use Autonomous Mode controls while a session is active.');
      const run = await this.autonomousService.runRepository.get(id);
      if (action === 'abandon' && !await this.isManualRun(id)) throw fail('Only manual autonomous runs can be abandoned.');
      if (action === 'resume' && run?.needsAttention) throw fail('Needs Attention: trusted operator review is required.');
      return this.autonomousService[action](id);
    });
  }
  async isManualRun(runId) {
    return !(await this.sessionRepository.list()).some(session => session.currentRunId === runId
      || session.projects?.some(project => project.runId === runId));
  }
  async request(action) {
    await this.initialize();
    return this.serialize(async () => {
      const session = await this.active();
      if (!session || this.closed) throw fail('No controllable active session.');
      const run = await this.currentRun(session);
      if (action === 'resume') {
        if (!['paused', 'needs_attention'].includes(session.status)) throw fail('Session must be paused or reviewed before resuming.');
        if (session.projects.length && (!run || !await this.owns(session, run))) throw fail('Resolve the interrupted reservation with a trusted operator first.');
        if (run && (run.needsAttention || run.state === 'failed' || !['completed', 'paused'].includes(run.state) || this.autonomousService.jobs.has(run.id))) throw fail('Resolve the current run through trusted recovery before resuming.');
        if (session.projects.at(-1)?.publishStatus === 'publishing' || session.projects.at(-1)?.publishStatus === 'failed') {
          const state = await this.publisher.status(run.projectId);
          if (state.publishStatus !== 'published') throw fail('Complete/reconcile publication manually before resuming.');
          await this.setPublishStatus(session.id, 'published');
        }
        if (run?.state === 'paused') await this.autonomousService.resume(run.id);
        const result = await this.patch(session.id, { status: 'running', lastError: null });
        this.schedule();
        return result;
      }
      if (!['pause', 'stop'].includes(action)) throw fail('Unknown session action.', 400);
      if (action === 'pause' && !['running', 'pausing'].includes(session.status)) throw fail('Only a running session can pause.');
      const result = await this.patch(session.id, { status: action === 'stop' ? 'stopping' : 'pausing' });
      // pause() records the checkpoint immediately but lets the in-flight operation settle.
      if (run && !terminal(run)) await this.autonomousService.pause(run.id, 'Autonomous Mode requested a safe checkpoint.');
      this.schedule();
      return result;
    });
  }
  setPublishStatus(id, status) {
    return this.sessionRepository.update(id, session => {
      session.projects.at(-1).publishStatus = status;
      session.updatedAt = new Date().toISOString();
      return true;
    });
  }
  async beginPublish(session, run) {
    await this.setPublishStatus(session.id, 'publishing');
    // Do not hold the coordinator lock across external I/O: Pause/Stop remains responsive.
    this.publishJob = Promise.resolve().then(() => this.publisher.publish(run.projectId))
      .then(result => {
        if (result.publishStatus !== 'published') throw new Error('Publication incomplete');
        return this.serialize(() => this.setPublishStatus(session.id, 'published'));
      }, () => this.serialize(async () => {
        await this.setPublishStatus(session.id, 'failed');
        await this.attention(session.id, 'Publishing failed. Review and publish manually before resuming.');
      }))
      .catch(() => this.serialize(() => this.attention(session.id, 'Publication could not be reconciled. Operator review required.')))
      .finally(() => { this.publishJob = null; this.schedule(); })
      .catch(() => { this.closed = true; });
  }
  async tick() {
    await this.initialize();
    await this.serialize(async () => {
      if (this.closed) return;
      let session = await this.active();
      if (!session || ['paused', 'needs_attention'].includes(session.status)) return;
      const run = await this.currentRun(session);
      if (session.projects.length && !run) return this.attention(session.id, 'The reserved run is missing. Operator review required.');
      if (run) {
        if (!await this.owns(session, run)) return this.attention(session.id, 'Session/run ownership mismatch.');
        session = await this.recordRun(session.id, run);
      }
      if (['pausing', 'stopping'].includes(session.status)) {
        if (this.publishJob || (run && this.autonomousService.jobs.has(run.id))) { this.schedule(); return; }
        if (run && !terminal(run) && run.state !== 'paused') return this.attention(session.id, 'Current run did not reach a safe checkpoint.');
        return this.patch(session.id, { status: session.status === 'stopping' ? 'stopped' : 'paused', completedAt: session.status === 'stopping' ? new Date().toISOString() : null });
      }
      if (run) {
        if (this.autonomousService.jobs.has(run.id)) { this.schedule(); return; }
        const continueAfterFailure = run.state === 'failed' && !session.stopOnNeedsAttention && ['implementation', 'package-contract', 'syntax', 'tests', 'startup', 'validation'].includes(run.failureAnalysis?.category);
        if (run.needsAttention && !continueAfterFailure) return this.attention(session.id, 'Current run needs operator attention. No new project was started.');
        if (run.state === 'paused') return this.patch(session.id, { status: run.pauseReason === 'Paused by user.' ? 'paused' : 'needs_attention', lastError: 'Current run paused. Review its checkpoint before resuming.' });
        if (run.state === 'failed' && !continueAfterFailure) return this.attention(session.id, 'Current project failed. Recover it before resuming.');
        if (!terminal(run)) return this.attention(session.id, 'Current run has no active worker. Operator recovery required.');
        if (run.state === 'completed' && session.autoPublish) {
          if (!run.validationPassed || !run.projectId) return this.attention(session.id, 'Completed project has no successful validation evidence.');
          const status = session.projects.at(-1).publishStatus;
          if (this.publishJob) { this.schedule(); return; }
          if (['publishing', 'failed'].includes(status)) return this.attention(session.id, 'Review interrupted publishing before resuming.');
          if (status !== 'published') { await this.beginPublish(session, run); this.schedule(); return; }
        }
      }
      if (session.projects.length >= session.maxProjects) {
        return session.completedProjects === session.maxProjects ? this.patch(session.id, { status: 'completed', completedAt: new Date().toISOString(), lastError: null }) :
          this.attention(session.id, 'Project attempt limit reached. Failed projects were not counted as completed.');
      }
      if (this.autonomousService.jobs.size || (await this.autonomousService.runRepository.list()).some(item => !terminal(item))) return this.attention(session.id, 'Another run owns the pipeline. Operator review required.');
      const requestId = `${session.id}-project-${session.projects.length + 1}`;
      // Persist before start: restart can resolve the create/link crash window by requestId.
      await this.sessionRepository.update(session.id, stored => {
        stored.projects.push({ requestId, runId: null, projectId: null, status: 'reserved', publishStatus: 'not_published' });
        stored.currentRunId = null; stored.currentProjectId = null; stored.updatedAt = new Date().toISOString();
        return true;
      });
      try {
        const started = await this.autonomousService.start({ requestId });
        if (started.run.config?.requestId !== requestId) return this.attention(session.id, 'Another run was returned; no additional execution requested.');
        await this.recordRun(session.id, started.run);
      } catch { return this.attention(session.id, 'Could not start the reserved run. Operator review required.'); }
      this.schedule();
    });
  }
  async snapshot() {
    await this.initialize();
    const sessions = await this.sessionRepository.list();
    const session = sessions.find(item => !finished(item.status)) || sessions[0];
    if (!session) return { session: null, active: false };
    const projects = [];
    let codexCalls = 0;
    for (const slot of session.projects) {
      const run = slot.runId && await this.autonomousService.runRepository.get(slot.runId);
      const project = run?.projectId && await this.projectRepository.get(run.projectId);
      codexCalls += Number.isInteger(run?.codexUsage?.codexCallsTotal) ? run.codexUsage.codexCallsTotal : 0;
      projects.push({ runId: slot.runId, projectId: run?.projectId || slot.projectId, name: project?.name?.slice(0, 100) || 'New SaaS', status: slot.status, publishStatus: slot.publishStatus });
    }
    const run = session.currentRunId && await this.autonomousService.runRepository.get(session.currentRunId);
    const project = run?.projectId && await this.projectRepository.get(run.projectId);
    return { active: !finished(session.status), session: {
      id: session.id, status: session.status, createdAt: session.createdAt, startedAt: session.startedAt, updatedAt: session.updatedAt, completedAt: session.completedAt,
      maxProjects: session.maxProjects, completedProjects: session.completedProjects, failedProjects: session.failedProjects,
      currentRunId: session.currentRunId, currentProjectId: session.currentProjectId, stopOnNeedsAttention: session.stopOnNeedsAttention,
      autoPublish: session.autoPublish, lastError: session.lastError, progress: Math.round(session.completedProjects / session.maxProjects * 100),
      current: run ? runSummary(run, project) : null, projects, codexCalls,
      averageCallsPerProject: session.projects.length ? Number((codexCalls / session.projects.length).toFixed(1)) : 0,
      nextAction: session.status === 'running' ? (this.publishJob ? 'Wait for publishing' : 'Continue current project, then the next unique idea') : session.status === 'pausing' || session.status === 'stopping' ? 'Wait for the current operation to reach a safe checkpoint' : 'Wait for user action'
    } };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer); this.timer = null;
    await this.control;
    await this.serialize(async () => {
      const session = await this.active();
      if (!session || !['running', 'pausing', 'stopping'].includes(session.status)) return;
      const run = await this.currentRun(session);
      await this.patch(session.id, { status: session.status === 'stopping' ? 'stopping' : 'pausing' });
      if (run && !terminal(run)) await this.autonomousService.pause(run.id, 'Factory shutdown requested a safe checkpoint.');
    });
    // No child is killed. The in-flight operation settles; startup reconciles persisted checkpoints.
  }
}
module.exports = { AutonomousModeService, validateSessionConfig };
