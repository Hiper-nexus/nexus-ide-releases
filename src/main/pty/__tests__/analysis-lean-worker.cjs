// Fixture: o protocolo do worker de produção depois do #17 — sem `work-start` por
// registro. O início do trabalho vai só para a memória compartilhada (horário
// primeiro, token depois, como AnalysisJobProgress.start) e o resultado é a única
// mensagem por registro.
const { parentPort, workerData } = require('node:worker_threads');
const progress = new BigInt64Array(workerData.analysisProgress);
parentPort.on('message', record => {
  const token = BigInt(record.watchdogToken || 1);
  Atomics.store(progress, 4, BigInt(Date.now()));
  Atomics.store(progress, 0, token);
  if (record.kind === 'data' && record.data === 'poison') { /^(a+)+$/.test('a'.repeat(5_000) + '!'); }
  Atomics.store(progress, 1, token);
  parentPort.postMessage({ ...record, kind: 'result', done: true, ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0, events: [] });
});
parentPort.postMessage({ kind: 'ready' });
