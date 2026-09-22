'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createStore } = require('./store');
const { AppError, filterDocuments } = require('./domain');

async function readBody(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AppError(415, 'Use application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new AppError(413, 'Request body exceeds 16 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON body.'); }
}

function createServer({ dataFile = path.join(__dirname, '..', 'data', 'documents.json') } = {}) {
  const store = createStore(dataFile);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    function send(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    }
    try {
      if (req.url.length > 2048) throw new AppError(414, 'Request URL is too long.');
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      const assets = {
        '/': ['index.html', 'text/html'],
        '/index.html': ['index.html', 'text/html'],
        '/styles.css': ['styles.css', 'text/css'],
        '/app.js': ['app.js', 'text/javascript']
      };
      if (Object.hasOwn(assets, route) && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = assets[route];
        const content = await fs.readFile(path.join(__dirname, '..', 'public', file));
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (route === '/api/health' && req.method === 'GET') return send(200, { status: 'ok' });
      if (['/api/documents', '/api/export'].includes(route) && req.method === 'GET') {
        const documents = filterDocuments(await store.list(), url.searchParams);
        if (route === '/api/documents') return send(200, { documents });
        const line = value => value.replace(/[\r\n\t]/g, ' ');
        const summary = ['Document Watch — renewal workflow', `${documents.length} document(s)`, '',
          ...documents.map(doc => `${doc.expiryDate} | ${line(doc.title)} | Owner: ${line(doc.owner)} | Review and arrange renewal`)].join('\n') + '\n';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="document-watch-summary.txt"' });
        return res.end(summary);
      }
      if (route === '/api/documents' && req.method === 'POST') {
        const document = await store.create(await readBody(req));
        res.setHeader('Location', `/api/documents/${document.id}`);
        return send(201, { document });
      }
      const match = route.match(/^\/api\/documents\/([a-f0-9-]{36})$/);
      if (match) {
        const id = match[1];
        if (req.method === 'GET') {
          const document = (await store.list()).find(doc => doc.id === id);
          if (!document) throw new AppError(404, 'Document not found.');
          return send(200, { document });
        }
        if (['PATCH', 'PUT'].includes(req.method)) return send(200, { document: await store.update(id, await readBody(req), req.method === 'PATCH') });
        if (req.method === 'DELETE') { await store.remove(id); return send(204); }
      }
      if (match || ['/api/health', '/api/documents', '/api/export'].includes(route)) {
        res.setHeader('Allow', match ? 'GET, PATCH, PUT, DELETE' : route === '/api/documents' ? 'GET, POST' : 'GET');
        throw new AppError(405, 'Method not allowed.');
      }
      throw new AppError(404, 'Route not found.');
    } catch (error) {
      send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Internal server error.' });
    }
  });
}

module.exports = { createServer };
