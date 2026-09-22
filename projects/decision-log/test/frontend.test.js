'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createServer } = require('../src/app');

function request(server, url, method = 'GET') {
  return new Promise(resolve => {
    const req = Readable.from([]);
    Object.assign(req, { url, method, headers: {} });
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: body?.toString() }); }
    };
    server.emit('request', req, res);
  });
}

test('dashboard and local assets are served with restrictive security headers', async () => {
  const server = createServer({ store: { list: async () => [] } });
  assert.equal(server.listening, false);
  for (const [url, type, content] of [['/', 'text/html', 'id="editor"'], ['/styles.css', 'text/css', '@media'], ['/app.js', 'text/javascript', '/api/decisions']]) {
    const response = await request(server, url);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], `${type}; charset=utf-8`);
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(response.headers['Content-Security-Policy'], /default-src 'self'/);
    assert.ok(response.body.includes(content));
    assert.equal((await request(server, url, 'HEAD')).body, undefined);
  }
  assert.deepEqual(JSON.parse((await request(server, '/api/health')).body), { status: 'ok' });
  assert.deepEqual(JSON.parse((await request(server, '/api/decisions')).body), []);
});

test('static serving rejects unsupported methods and exposes only explicit public assets', async () => {
  const server = createServer({ store: { list: async () => [] } });
  assert.equal((await request(server, '/', 'POST')).status, 405);
  for (const url of ['/src/app.js', '/package.json', '/public/index.html', '/%2e%2e/package.json', '/constructor']) {
    assert.equal((await request(server, url)).status, 404);
  }
});
