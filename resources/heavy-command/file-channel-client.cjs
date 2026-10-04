const io = require('./file-channel-io.cjs');
const { fs, path, SLOTS, name, same } = io;
module.exports = function fileReply(directory, packet) {
  const identity = io.directoryIdentity(directory), deadline = Date.now() + 360000;
  let request, timer, finished = false;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (request) { io.checkDirectory(directory, identity); io.unlink(request.file, request.identity); request = undefined; }
  };
  const stop = () => { try { cleanup(); } catch {} process.exit(78); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (finished) return; finished = true;
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      try { cleanup(); } catch (failure) { error = failure; }
      if (error) reject(error); else resolve(value);
    };
    const poll = () => {
      try {
        io.checkDirectory(directory, identity);
        if (Date.now() > deadline) { finish(new Error('file_request_timeout')); return; }
        if (!request) {
          for (let slot = 0; slot < SLOTS; slot++) {
            const file = path.join(directory, name('request', slot)); let opened;
            try { opened = io.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL); }
            catch (error) { if (error.code === 'EEXIST') continue; throw error; }
            request = { file, identity: opened.identity, slot };
            try { io.write(opened.fd, file, JSON.stringify(packet)); } finally { fs.closeSync(opened.fd); }
            break;
          }
        }
        if (request) {
          const stat = fs.lstatSync(request.file); if (!same(stat, request.identity)) throw new Error('request_changed');
          const file = path.join(directory, name('response', request.slot)), opened = io.open(file, fs.constants.O_RDONLY);
          let raw; try { raw = io.read(opened.fd, file); } finally { fs.closeSync(opened.fd); }
          if (raw) {
            let reply; try { reply = JSON.parse(raw); } catch { /* publication in progress */ }
            if (reply?.id === packet.id) { finish(undefined, raw); return; }
          }
        }
        timer = setTimeout(poll, 25);
      } catch (error) { if (error.message === 'file_changed') timer = setTimeout(poll, 25); else finish(error); }
    };
    poll();
  });
};
