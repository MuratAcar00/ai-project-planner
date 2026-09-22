'use strict';

const { createServer } = require('./app');
const server = createServer();
server.listen(3000, '127.0.0.1', () => {
  console.log('Decision Log listening on http://localhost:3000');
});
