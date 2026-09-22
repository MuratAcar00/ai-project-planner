'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('./store');
const { HttpError, validate, createRecord, equipmentView } = require('./domain');
const MAX_BODY = 16384;

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function find(records, id) {
  const record = records.find((item) => item.id === id);
  if (!record) throw new HttpError(404, 'Record not found');
  return record;
}

function createServer(options = {}) {
  const store = options.store || new Store(options.dataFile);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (Object.hasOwn(assets, pathname)) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD');
          throw new HttpError(405, 'Method not allowed');
        }
        const [file, type] = assets[pathname];
        const content = await fs.readFile(path.join(__dirname, '..', 'public', file), 'utf8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (pathname === '/api/health' && req.method === 'GET') return send(200, { status: 'ok' });
      if (pathname === '/api/export' && req.method === 'GET') {
        const state = await store.read();
        const lines = ['Service Calendar — workflow summary', 'Register equipment → set interval and first due date → record completed service.', ''];
        for (const item of state.equipment) {
          const view = equipmentView(item, state.services);
          const history = state.services.filter((service) => service.equipmentId === item.id).sort((a, b) => b.date.localeCompare(a.date));
          lines.push(`${item.name.replace(/\s+/g, ' ')} | Every ${item.intervalDays} days | Due ${view.dueDate} | ${view.status} | ${history.length} services`);
          if (history[0]) lines.push(`  Last service: ${history[0].date} — ${history[0].description.replace(/\s+/g, ' ')}`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="service-calendar-summary.txt"' });
        return res.end(`${lines.join('\n')}\n`);
      }
      const match = /^\/api\/equipment(?:\/([a-zA-Z0-9-]+)(?:\/(services)(?:\/([a-zA-Z0-9-]+))?)?)?$/.exec(pathname);
      if (!match) throw new HttpError(404, 'Route not found');
      const [, equipmentId, servicesRoute, serviceId] = match;
      const kind = servicesRoute ? 'service' : 'equipment';
      const id = servicesRoute ? serviceId : equipmentId;
      const allowed = id ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new HttpError(405, 'Method not allowed');
      }
      const select = (state) => {
        if (servicesRoute) {
          find(state.equipment, equipmentId);
          return state.services.filter((item) => item.equipmentId === equipmentId);
        }
        return state.equipment;
      };
      const view = (record, state) => kind === 'equipment' ? equipmentView(record, state.services) : record;
      if (req.method === 'GET') {
        const state = await store.read();
        const records = select(state);
        return send(200, id ? view(find(records, id), state) : records.map((item) => view(item, state)));
      }
      const input = req.method === 'DELETE' ? undefined : await readBody(req);
      const result = await store.update((state) => {
        const records = select(state);
        if (req.method === 'POST') {
          const record = createRecord(input, kind);
          if (servicesRoute) record.equipmentId = equipmentId;
          state[servicesRoute ? 'services' : 'equipment'].push(record);
          return view(record, state);
        }
        const record = find(records, id);
        if (req.method === 'PATCH') {
          Object.assign(record, validate(input, kind, true));
          return view(record, state);
        }
        if (servicesRoute) state.services = state.services.filter((item) => item.id !== id);
        else {
          state.equipment = state.equipment.filter((item) => item.id !== id);
          state.services = state.services.filter((item) => item.equipmentId !== id);
        }
      });
      if (req.method === 'POST') res.setHeader('Location', `${pathname}/${result.id}`);
      send(req.method === 'POST' ? 201 : req.method === 'DELETE' ? 204 : 200, result);
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

module.exports = { createServer };
