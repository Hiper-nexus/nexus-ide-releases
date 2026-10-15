// Fixture: Worker que só começa o registro depois do tempo de trabalho de 250 ms
// (máquina carregada, swap). 'late-complete' termina logo ao começar; 'late-poison'
// começa e trava (regex catastrófico). Mesmo layout de AnalysisJobProgress.
const { parentPort, workerData } = require('node:worker_threads');
const progress = new BigInt64Array(workerData.analysisProgress);
parentPort.on('message', record => {
  const token = BigInt(record.watchdogToken || 1);
  const begin = () => {
    Atomics.store(progress, 4, process.hrtime.bigint());
    Atomics.store(progress, 0, token);
    if (record.kind === 'data' && record.data === 'late-poison') { /^(a+)+$/.test('a'.repeat(5_000) + '!'); }
    Atomics.store(progress, 1, token);
    parentPort.postMessage({ ...record, kind: 'result', done: true, ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0, events: [] });
  };
  if (record.kind === 'data' && record.data.startsWith('late-')) setTimeout(begin, record.data === 'late-poison' ? 1_900 : 1_700);
  else begin();
});
parentPort.postMessage({ kind: 'ready' });
