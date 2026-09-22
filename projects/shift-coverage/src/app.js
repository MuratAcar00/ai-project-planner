'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assets = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
const { createStore } = require('./store');
const { AppError, collections, saveRecord, removeRecord, find, coverage, summary } = require('./domain');
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new AppError(415, 'Content-Type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new AppError(413, 'Request body exceeds 16 KB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON'); }
}
function createServer({ dataFile, store = createStore(dataFile) } = {}) {
  const server = http.createServer(async (request, response) => {
    const send = (status, value, plain = false) => {
      response.writeHead(status, {
        'Content-Type': plain ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        ...(plain ? { 'Content-Disposition': 'attachment; filename="shift-coverage.txt"' } : {})
      });
      response.end(status === 204 ? undefined : plain ? value : JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (Object.hasOwn(assets, url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        const [file, type] = assets[url.pathname];
        const content = await fs.readFile(path.join(__dirname, '..', 'public', file));
        response.writeHead(200, {
          'Content-Type': `${type}; charset=utf-8`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      const method = request.method;
      if (url.pathname === '/api/health' && method === 'GET') return send(200, { status: 'ok' });
      if (['/api/coverage', '/api/summary'].includes(url.pathname) && method === 'GET') {
        const eventId = url.searchParams.get('eventId');
        return url.pathname === '/api/coverage' ? send(200, coverage(store.read(), eventId)) : send(200, summary(store.read(), eventId), true);
      }
      if (parts[0] !== 'api' || !collections.includes(parts[1]) || parts.length > 3) throw new AppError(404, 'Route not found');
      const [, collection, id] = parts;
      if (method === 'GET') {
        const state = store.read();
        return send(200, id ? find(state, collection, id) : state[collection]);
      }
      if ((method === 'POST' && !id) || (['PUT', 'PATCH'].includes(method) && id)) {
        const body = await readBody(request);
        const result = store.mutate((state) => saveRecord(state, collection, body, id));
        return send(id ? 200 : 201, result);
      }
      if (method === 'DELETE' && id) {
        store.mutate((state) => removeRecord(state, collection, id));
        return send(204);
      }
      response.setHeader('Allow', id ? 'GET, PUT, PATCH, DELETE' : 'GET, POST');
      throw new AppError(405, 'Method not allowed');
    } catch (error) {
      if (!response.destroyed) send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createServer };
