'use strict';

const { createServer } = require('./app');

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
const server = createServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`Document Watch listening on http://127.0.0.1:${server.address().port}`);
});
