// The fixed UtilityProcess entry selects this mode before creating endpoints.
const io = require('./file-channel-io.cjs');
const { fs, path, SLOTS, name, same } = io;
const directory = process.cwd(), directoryIdentity = io.directoryIdentity(directory);
const port = process.parentPort;
const send = value => port ? port.postMessage(value) : process.send?.(value);
const responses = [], active = new Map();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let closed = false, scanning = false;
for (let slot = 0; slot < SLOTS; slot++) {
  const file = path.join(directory, name('response', slot));
  responses.push({ ...io.open(file, fs.constants.O_RDWR), file });
}
function cancel(slot, request) {
  active.delete(slot); if (request.id && !request.responded) send({ type: 'cancel', id: request.id });
}
function scan() {
  if (closed || scanning) return; scanning = true;
  try {
    io.checkDirectory(directory, directoryIdentity);
    for (let slot = 0; slot < SLOTS; slot++) {
      const response = responses[slot]; io.inspect(response.fd, response.file);
      const file = path.join(directory, name('request', slot));
      let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const previous = active.get(slot);
      if (previous) {
        if (!stat || !same(stat, previous.identity)) { cancel(slot, previous); continue; }
        if (Date.now() - previous.started > (previous.id ? 360000 : 5000)) cancel(slot, previous);
        else if (previous.id) {
          let opened;
          try { opened = io.open(file, fs.constants.O_RDONLY); if (!same(opened.identity, previous.identity) || io.read(opened.fd, file) !== previous.raw) cancel(slot, previous); }
          catch { cancel(slot, previous); }
          finally { if (opened) fs.closeSync(opened.fd); }
          continue;
        }
      }
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > io.MAX) continue;
      const request = previous || { identity: stat, started: Date.now() }; active.set(slot, request);
      let input;
      try { const opened = io.open(file, fs.constants.O_RDONLY); try { input = io.read(opened.fd, file); } finally { fs.closeSync(opened.fd); } } catch { continue; }
      let id; try { id = JSON.parse(input).id; } catch { continue; }
      if (!idPattern.test(id || '') || [...active.values()].some(value => value !== request && value.id === id)) continue;
      request.id = id; request.raw = input;
      send({ type: 'request', id, raw: input, slot, identity: { dev: stat.dev, ino: stat.ino } });
    }
  } catch { close(1); } finally { scanning = false; }
}
function close(code = 0) {
  if (closed) return; closed = true;
  for (const [slot, request] of active) cancel(slot, request);
  // Never unlink/truncate paths during teardown; Main owns cleanup by inode.
  process.exit(code);
}
function receive(message) {
  if (message?.type === 'close') { close(); return; }
  if (message?.type !== 'response' || typeof message.raw !== 'string' || Buffer.byteLength(message.raw) > io.MAX) return;
  for (const [slot, request] of active) {
    if (request.id !== message.id || request.responded) continue;
    const file = path.join(directory, name('request', slot));
    try {
      io.checkDirectory(directory, directoryIdentity);
      const opened = io.open(file, fs.constants.O_RDONLY);
      try { if (!same(opened.identity, request.identity) || io.read(opened.fd, file) !== request.raw) { cancel(slot, request); return; } } finally { fs.closeSync(opened.fd); }
      const response = responses[slot]; io.write(response.fd, response.file, message.raw); request.responded = true;
    } catch { cancel(slot, request); }
    return;
  }
}
if (port) { port.on('message', event => receive(event.data)); port.on('close', () => close()); } else process.on('message', receive);
process.on('disconnect', () => close()); process.on('SIGTERM', () => close());
const watcher = fs.watch(directory, scan); watcher.on('error', () => close(1));
setInterval(scan, 250);
send({ type: 'ready', transport: 'file', responses: responses.map((value, slot) => ({ name: name('response', slot), dev: value.identity.dev, ino: value.identity.ino })) });
