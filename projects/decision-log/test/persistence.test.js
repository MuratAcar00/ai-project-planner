'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DecisionStore } = require('../src/store');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '..', '.test-data-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'decisions.json');
  return { directory, file, store: new DecisionStore(file) };
}
const sample = { title: 'Choice', decision: 'Proceed' };

test('invalid persisted records fail closed without changing the file', async t => {
  const { store, file } = await fixture(t);
  const record = await store.create(sample);
  const missingTags = { ...record };
  delete missingTags.tags;
  for (const records of [[missingTags], [{ ...record, id: 'unreachable' }],
    [{ ...record, updatedAt: 'not a date' }], [{ ...record, createdAt: '2026-02-30T00:00:00.000Z' }],
    [record, record], [{ ...record, title: ' ' }]]) {
    const raw = JSON.stringify(records);
    await fs.writeFile(file, raw);
    await assert.rejects(store.list());
    await assert.rejects(store.create(sample));
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('failed atomic replacement cleans temporary files and the queue recovers', async t => {
  const { directory, file, store } = await fixture(t);
  await fs.mkdir(file);
  // Reading a directory fails before writing; then exercise rename failure explicitly.
  await assert.rejects(store.create(sample));
  await fs.rmdir(file);
  const read = store.read.bind(store);
  store.read = async () => {
    const records = await read();
    await fs.mkdir(file);
    return records;
  };
  await assert.rejects(store.create(sample));
  assert.deepEqual(await fs.readdir(directory), ['decisions.json']);
  await fs.rmdir(file);
  store.read = read;
  const record = await store.create(sample);
  assert.deepEqual(await new DecisionStore(file).list(), [record]);
});

test('failed updates preserve bytes and queued updates retain unrelated fields', async t => {
  const { store, file } = await fixture(t);
  const record = await store.create(sample);
  const before = await fs.readFile(file, 'utf8');
  assert.throws(() => store.update(record.id, { title: '' }));
  await assert.rejects(store.update('missing', { title: 'Changed' }), { status: 404 });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await Promise.all([store.update(record.id, { title: 'Changed' }), store.update(record.id, { tags: ['Team'] })]);
  const [updated] = await store.list();
  assert.equal(updated.title, 'Changed');
  assert.deepEqual(updated.tags, ['Team']);
  assert.equal(updated.createdAt, record.createdAt);
  await store.update(record.id, { title: 'Replacement', decision: 'Stop' }, false);
  assert.deepEqual((await store.list())[0].tags, []);
});
