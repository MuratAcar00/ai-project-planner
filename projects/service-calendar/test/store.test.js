'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('../src/store');
const { createRecord } = require('../src/domain');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, 'nested', 'calendar.json');
  return { directory, dataFile, store: new Store(dataFile) };
}
const record = () => createRecord({ name: 'Lathe', intervalDays: 30, nextServiceDate: '2026-01-01' }, 'equipment');

test('missing storage initializes lazily and independent instances serialize writes', async (t) => {
  const { store, dataFile } = await fixture(t);
  assert.deepEqual(await store.read(), { version: 1, equipment: [], services: [] });
  await assert.rejects(fs.stat(dataFile), { code: 'ENOENT' });
  await Promise.all(Array.from({ length: 20 }, () => new Store(dataFile).update((state) => state.equipment.push(record()))));
  const saved = await new Store(dataFile).read();
  assert.equal(saved.equipment.length, 20);
  assert.equal(new Set(saved.equipment.map((item) => item.id)).size, 20);
  assert.deepEqual(await fs.readdir(path.dirname(dataFile)), ['calendar.json']);
});

test('failed mutations preserve bytes and do not poison later writes', async (t) => {
  const { store, dataFile } = await fixture(t);
  await store.update((state) => state.equipment.push(record()));
  const before = await fs.readFile(dataFile, 'utf8');
  await assert.rejects(store.update((state) => { state.equipment.length = 0; throw new Error('Rejected'); }), /Rejected/);
  assert.equal(await fs.readFile(dataFile, 'utf8'), before);
  await assert.rejects(store.update((state) => { state.equipment[0].intervalDays = 0; }), /Invalid data store/);
  assert.equal(await fs.readFile(dataFile, 'utf8'), before);
  await store.update((state) => { state.equipment[0].name = 'Updated'; });
  assert.equal((await store.read()).equipment[0].name, 'Updated');
});

test('malformed state and broken references are rejected without overwriting storage', async (t) => {
  const { store, dataFile } = await fixture(t);
  await fs.mkdir(path.dirname(dataFile));
  const item = record();
  const service = { ...createRecord({ date: '2026-01-01', description: 'Check' }, 'service'), equipmentId: 'missing' };
  for (const state of [null, {}, { version: 2, equipment: [], services: [] },
    { version: 1, equipment: [item, item], services: [] },
    { version: 1, equipment: [item], services: [service] },
    { version: 1, equipment: [{ ...item, createdAt: 'bad' }], services: [] },
    { version: 1, equipment: [{ ...item, intervalDays: 0 }], services: [] }]) {
    const bytes = JSON.stringify(state);
    await fs.writeFile(dataFile, bytes);
    await assert.rejects(store.read(), /Invalid data store/);
    await assert.rejects(store.update(() => {}), /Invalid data store/);
    assert.equal(await fs.readFile(dataFile, 'utf8'), bytes);
  }
});

test('filesystem failures propagate and queued updates recover', async (t) => {
  const { directory } = await fixture(t);
  const blocker = path.join(directory, 'blocker');
  await fs.writeFile(blocker, 'file');
  const store = new Store(path.join(blocker, 'calendar.json'));
  await assert.rejects(store.update(() => {}), { code: 'ENOTDIR' });
  await fs.unlink(blocker);
  await store.update((state) => state.equipment.push(record()));
  assert.equal((await store.read()).equipment.length, 1);
});
