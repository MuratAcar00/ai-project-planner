const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, finish, deferred } = require('./autonomous-helpers');
const { TemplateIdeaProvider } = require('../src/providers/template-idea-provider');
const { LocalIdeaProvider } = require('../src/providers/local-idea-provider');
const { IdeaEvaluator } = require('../src/services/idea-evaluator');
const { IdeaNoveltyService } = require('../src/services/idea-novelty-service');
const { eventSummary } = require('../src/autonomous/presentation');
const ideas = () => new TemplateIdeaProvider().generateIdeas();

test('empty history selects deterministic idea; previous Decision Log excludes it', async () => {
  const candidates = await ideas();
  const evaluator = new IdeaEvaluator();
  assert.equal(evaluator.select(candidates).selected.name, 'Decision Log');
  const selection = evaluator.select(candidates, [candidates[1]]);
  assert.notEqual(selection.selected.name, 'Decision Log');
  assert.equal(selection.evaluations.find(e => e.ideaId === 'decision-log').duplicate, true);
});

test('normalized names and same problem with different names are duplicates', async () => {
  const original = (await ideas())[1];
  const novelty = new IdeaNoveltyService();
  assert.equal(novelty.check({ ...original, name: '  DECISION--Lóg ' }, [original]).duplicate, true);
  assert.equal(novelty.check({ ...original, name: 'Meeting Memory' }, [original]).duplicate, true);
  assert.equal(novelty.check({ ...original, name: 'Meeting Memory', problem: 'Between meetings, decision context disappears!' }, [original]).duplicate, true);
  assert.equal(novelty.check((await ideas())[0], [original]).duplicate, false);
});

test('history includes completed, building, paused and failed selections and manual projects', async t => {
  const f = await fixture(t);
  const original = (await ideas())[1];
  for (const state of ['completed', 'executing', 'paused', 'failed']) await f.dependencies.runRepository.create({ id: state, state, selection: { selected: { ...original, name: state } } });
  await f.dependencies.projectRepository.create({ id: 'manual', name: 'Existing manual project', description: 'A manual workflow' });
  const history = await new IdeaNoveltyService().history(f.dependencies.projectRepository, f.dependencies.runRepository);
  assert.equal(history.length, 5);
  assert.ok(history.some(h => h.name === 'paused'));
});

test('duplicate first batch retries second batch and persists readable rejection', async t => {
  const candidates = await ideas();
  const batches = [];
  const f = await fixture(t, { ideaProvider: { async generateIdeas({ batch }) { batches.push(batch); return batch === 1 ? [candidates[1]] : [candidates[0]]; } } });
  await f.dependencies.projectRepository.create({ id: 'prior', plan: { phases: [] }, runs: [], name: 'Decision Log', idea: candidates[1] });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'completed');
  assert.deepEqual(batches, [1, 2]);
  assert.equal(done.selection.selected.name, 'Scope Board');
  const rejection = done.events.find(e => e.type === 'rejected_as_duplicate');
  assert.match(eventSummary({ ...rejection, similarity: 'private' }, done).message, /Decision Log/);
  assert.equal(JSON.stringify(eventSummary(rejection, done)).includes('similarity'), false);
});

test('exhausted batches pause with needs attention and never create or execute a project', async t => {
  const candidate = (await ideas())[1];
  const f = await fixture(t, { maxIdeaBatches: 2, ideaProvider: { async generateIdeas() { return [candidate]; } } });
  await f.dependencies.projectRepository.create({ id: 'prior', plan: { phases: [] }, runs: [], name: candidate.name, idea: candidate });
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(done.needsAttention, true);
  assert.equal(done.ideaBatch, 2);
  assert.equal(done.projectId, null);
  assert.equal(done.events.filter(e => e.type === 'rejected_as_duplicate').length, 2);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
});

test('concurrent starts with different request IDs create only one project', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['first', 'second', 'third'].map(requestId => f.service.start({ requestId })));
  assert.equal(new Set(results.map(r => r.run.id)).size, 1);
  await finish(f.service, results[0].run.id);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
});

test('final gate rechecks history changed after selection', async t => {
  const candidate = (await ideas())[1];
  const f = await fixture(t, { maxIdeaBatches: 1, ideaProvider: { async generateIdeas() { return [candidate]; } } });
  const permitted = f.service.permitted.bind(f.service);
  f.service.permitted = async (id, action) => {
    if (action === 'plan_project') await f.dependencies.projectRepository.create({ id: 'racing-project', idea: candidate, name: candidate.name });
    return permitted(id, action);
  };
  const { run } = await f.service.start();
  const done = await finish(f.service, run.id);
  assert.equal(done.state, 'paused');
  assert.equal(done.projectId, null);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.dependencies.projectRepository.list()).length, 1);
  assert.ok(done.events.some(e => e.type === 'rejected_as_duplicate'));
});

test('pause while ideas are generating prevents project creation and execution', async t => {
  const entered = deferred(); const released = deferred();
  const f = await fixture(t, { ideaProvider: { async generateIdeas() { entered.resolve(); await released.promise; return ideas(); } } });
  const { run } = await f.service.start();
  await entered.promise;
  await f.service.pause(run.id);
  released.resolve();
  assert.equal((await finish(f.service, run.id)).state, 'paused');
  assert.equal((await f.dependencies.projectRepository.list()).length, 0);
  assert.equal(f.calls.length, 0);
});

test('production provider provides structured domains across bounded batches and diversity rewards unused domains', async () => {
  const provider = new LocalIdeaProvider({ offset: 0 });
  const all = [];
  for (let batch = 1; batch <= 4; batch++) all.push(...await provider.generateIdeas({ batch }));
  assert.equal(new Set(all.map(i => i.problemKey)).size, 12);
  for (const candidate of all) for (const key of ['name', 'problem', 'targetUser', 'coreWorkflow', 'mvpScope', 'differentiators', 'complexity', 'domain']) assert.ok(candidate[key]);
  const evaluator = new IdeaEvaluator();
  const history = [{ name: 'Other developer tool', domain: all[0].domain }];
  const result = evaluator.select([all[0], all[1]], history);
  assert.equal(result.selected.id, all[1].id);
  assert.equal(new IdeaNoveltyService().check(all.find(i => i.name === 'Decision Log'), [(await ideas())[1]]).duplicate, true);
});

test('sequential completed runs do not select the previous project again', async t => {
  const f = await fixture(t);
  const first = await f.service.start();
  const previous = await finish(f.service, first.run.id);
  const second = await f.service.start();
  const next = await finish(f.service, second.run.id);
  assert.equal(next.state, 'completed');
  assert.notEqual(next.selection.selected.name, previous.selection.selected.name);
  assert.equal((await f.dependencies.projectRepository.list()).length, 2);
});

test('pause admitted before final project gate prevents creation', async t => {
  const f = await fixture(t);
  const permitted = f.service.permitted.bind(f.service);
  f.service.permitted = async (id, action) => {
    if (action === 'plan_project') await f.service.pause(id);
    return permitted(id, action);
  };
  const { run } = await f.service.start();
  assert.equal((await finish(f.service, run.id)).state, 'paused');
  assert.equal((await f.dependencies.projectRepository.list()).length, 0);
  assert.equal(f.calls.length, 0);
});
