// Fixed byte transport. Main owns context, authentication and all admission.
if (process.argv[2] === '--file' && process.argv.length === 3) {
  require('./file-channel-server.cjs');
} else if (process.argv.length !== 2) {
  process.exit(1);
} else {
const http = require('node:http');
const port = process.parentPort;
const send = value => port ? port.postMessage(value) : process.send?.(value);
const clients = new Map();
const connections = new Map();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const server = http.createServer({ maxHeaderSize: 2048 }, (req, res) => {
  const connection = connections.get(req.socket);
  if (!connection || connection.used || req.method !== 'POST' || req.url !== '/hook/heavy-command' || clients.size >= 16) { req.socket.destroy(); return; }
  connection.used = true;
  let raw = '', id;
  req.on('data', part => { raw += part; if (Buffer.byteLength(raw) > 2048) req.destroy(); });
  req.on('end', () => {
    clearTimeout(connection.timer);
    try { id = JSON.parse(raw).id; } catch {}
    if (!idPattern.test(id || '') || clients.has(id)) { res.writeHead(400); res.end('{}'); return; }
    const timer = setTimeout(() => { send({ type: 'cancel', id }); res.destroy(); }, 360000);
    clients.set(id, { res, timer }); send({ type: 'request', id, raw });
    res.once('close', () => { clearTimeout(timer); if (clients.delete(id)) send({ type: 'cancel', id }); });
  });
});
server.maxConnections = 16;
server.on('connection', socket => {
  if (connections.size >= 16) { socket.destroy(); return; }
  const timer = setTimeout(() => socket.destroy(), 5000);
  connections.set(socket, { timer, used: false });
  socket.once('close', () => { clearTimeout(timer); connections.delete(socket); });
});
server.maxHeadersCount = 16;
server.headersTimeout = 5000; server.requestTimeout = 5000;
function close() {
  for (const [id, client] of clients) { clearTimeout(client.timer); send({ type: 'cancel', id }); client.res.destroy(); }
  clients.clear();
  // net.Server.close auto-unlinks its remembered pathname, even if another
  // inode replaced it. Exit this byte-only process; Main removes only the
  // original socket identity after observing our actual exit.
  process.exit(0);
}
function receive(message) {
  if (message?.type === 'close') { close(); return; }
  if (message?.type !== 'response' || typeof message.raw !== 'string' || Buffer.byteLength(message.raw) > 2048) return;
  const client = clients.get(message.id); if (!client) return;
  clients.delete(message.id); clearTimeout(client.timer);
  client.res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); client.res.end(message.raw);
}
if (port) { port.on('message', event => receive(event.data)); port.on('close', close); } else process.on('message', receive);
process.on('disconnect', close); process.on('SIGTERM', close);
server.once('error', () => process.exit(1));
// A relative endpoint keeps long private TMP paths out of sockaddr_un.
server.listen('heavy.sock', () => send({ type: 'ready' }));
}
