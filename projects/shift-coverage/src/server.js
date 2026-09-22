'use strict';

const { createServer } = require('./app');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
createServer().listen(port, '127.0.0.1', () => {
  console.log(`Shift Coverage listening on http://localhost:${port}`);
});
