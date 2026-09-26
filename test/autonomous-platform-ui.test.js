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
  assert.match(source, /run\.canAbandon[\s\S]*data-action="abandon"/);
  assert.match(source, /window\.confirm\('Abandon this paused run\?/);
  assert.match(source, /run\.canRetryValidation[\s\S]*Retry Validation/);
  assert.match(source, /Application validation:/);
  assert.match(source, /Android APK:/);
  assert.match(source, /window\.confirm\('Retry validation for this run\?/);
  assert.match(source, /\/api\/autonomous\/\$\{encodeURIComponent\(button\.dataset\.run\)\}\/\$\{button\.dataset\.action\}/);
});
