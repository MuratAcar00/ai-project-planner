const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('single-project dashboard offers only the four safe platform preferences and submits the selection', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const select = html.match(/<select id="platform-preference">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);
  const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, value, label]) => [value, label]);
  assert.deepEqual(options, [['auto', 'Auto'], ['web', 'Web'], ['mobile', 'Mobile'], ['web_mobile', 'Web + Mobile']]);
  assert.match(source, /document\.querySelector\('#platform-preference'\)\.value/);
  assert.match(source, /JSON\.stringify\(\{ requestId, platformPreference \}\)/);
  assert.match(source, /run\.blocksNewRun \?\? !terminal\(run\)/);
});
