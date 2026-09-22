'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DecisionStore } = require('./store');
const { ValidationError, validateDate } = require('./validation');
const MAX_BODY = 128 * 1024;

function send(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      request.resume();
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('Invalid JSON body'); }
}

function filter(records, params) {
  for (const [key, value] of params) {
    if (!['q', 'tag', 'reviewBefore'].includes(key) || value.length > 200 || params.getAll(key).length > 1) {
      throw new ValidationError('Invalid search parameter');
    }
  }
  const q = (params.get('q') || '').trim().toLowerCase();
  const tag = params.get('tag')?.trim().toLowerCase();
  const before = params.has('reviewBefore') ? validateDate(params.get('reviewBefore')) : null;
  return records.filter(record =>
    (!q || [record.title, record.context, record.decision, ...record.alternatives, ...record.tags]
      .some(value => value.toLowerCase().includes(q))) &&
    (!tag || record.tags.some(value => value.toLowerCase() === tag)) &&
    (!before || (record.reviewDate !== null && record.reviewDate <= before))
  );
}

function createServer(options = {}) {
  const store = options.store || new DecisionStore(options.dataFile);
  return http.createServer(async (request, response) => {
    try {
      if (request.url.length > 2048) throw new ValidationError('URL too long');
      const url = new URL(request.url, 'http://localhost');
      const route = url.pathname;
      const method = request.method;
      const assets = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      if (Object.hasOwn(assets, route)) {
        if (!['GET', 'HEAD'].includes(method)) return send(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
        const [file, type] = assets[route];
        const content = await fs.readFile(path.join(__dirname, '..', 'public', file));
        response.writeHead(200, {
          'Content-Type': `${type}; charset=utf-8`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        });
        return response.end(method === 'HEAD' ? undefined : content);
      }
      if (route === '/api/health' && method === 'GET') return send(response, 200, { status: 'ok' });
      if (route === '/api/decisions' || route === '/api/decisions/export') {
        if (method === 'GET') {
          const records = filter(await store.list(), url.searchParams);
          return send(response, 200, records, route.endsWith('/export') ? {
            'Content-Disposition': 'attachment; filename="decisions.json"'
          } : {});
        }
        if (route === '/api/decisions' && method === 'POST') {
          const record = await store.create(await body(request));
          return send(response, 201, record, { Location: `/api/decisions/${record.id}` });
        }
        return send(response, 405, { error: 'Method not allowed' }, { Allow: route.endsWith('/export') ? 'GET' : 'GET, POST' });
      }
      const match = /^\/api\/decisions\/([a-f0-9-]{36})$/.exec(route);
      if (match) {
        const id = match[1];
        if (method === 'GET') {
          const record = (await store.list()).find(item => item.id === id);
          return send(response, record ? 200 : 404, record || { error: 'Decision not found' });
        }
        if (method === 'PATCH' || method === 'PUT') return send(response, 200, await store.update(id, await body(request), method === 'PATCH'));
        if (method === 'DELETE') {
          await store.delete(id);
          return send(response, 204);
        }
        return send(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, PUT, PATCH, DELETE' });
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof ValidationError ? 400 : [404, 413, 415].includes(error.status) ? error.status : 500;
      if (!response.destroyed) send(response, status, { error: status === 500 ? 'Internal server error' : error.message });
    }
  });
}

module.exports = { createServer };
