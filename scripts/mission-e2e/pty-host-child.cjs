'use strict';
// F-971: o host de PTY REAL (src/main/pty/pty-host-entry.ts) fora do Electron.
// No app ele roda num utilityProcess e fala com o Main por `process.parentPort`;
// aqui o mesmo contrato viaja pelo canal IPC do Node (fork com
// serialization 'advanced', o mesmo clone estruturado do utilityProcess).
// Nada de política mora aqui: só o transporte.
if (typeof process.send !== 'function') {
  process.stderr.write('pty-host-child: precisa do canal IPC do fork\n');
  process.exit(2);
}
process.parentPort = {
  on(event, listener) {
    if (event === 'message') process.on('message', (data) => listener({ data }));
  },
  postMessage(message) {
    try { process.send(message); } catch { /* Main saiu; o disconnect encerra o host */ }
  },
};
// Como no app: a morte do Main leva o host, e a do host leva os PTYs.
process.on('disconnect', () => process.exit(0));
require('../../src/main/pty/pty-host-entry.ts');
