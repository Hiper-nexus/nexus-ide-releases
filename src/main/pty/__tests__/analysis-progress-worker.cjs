const { parentPort, workerData } = require('node:worker_threads');
const progress = new BigInt64Array(workerData.analysisProgress);
parentPort.on('message', record => {
  const token = record.watchdogToken || 1;
  Atomics.store(progress, 0, BigInt(token));
  parentPort.postMessage({ kind: 'work-start', sessionId: record.sessionId, workerEpoch: record.workerEpoch, job: record.eventSeq, watchdogToken: record.watchdogToken });
  if (record.kind === 'data' && record.data === 'poison') { /^(a+)+$/.test('a'.repeat(5_000) + '!'); }
  const reply = () => {
    Atomics.store(progress, 1, BigInt(token));
    if (record.kind === 'data' && record.data === 'missing-ack') return;
    parentPort.postMessage({ ...record, kind: 'result', done: true, ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0, events: [] });
    if (record.kind === 'data' && record.data.startsWith('background-')) setTimeout(() => {
      Atomics.store(progress, 2, 1n);
      parentPort.postMessage({ kind: 'work-start', sessionId: record.sessionId, workerEpoch: 0, job: 0, activityToken: 1, manifestId: 'finite-background' });
      if (record.data === 'background-poison') /^(a+)+$/.test('a'.repeat(5_000) + '!');
      setTimeout(() => { Atomics.store(progress, 3, 1n); parentPort.postMessage({ kind: 'work-end', activityToken: 1 }); }, 20);
    }, 5);
  };
  if (record.kind === 'data') setTimeout(reply, 20);
  else reply();
});
parentPort.postMessage({ kind: 'ready' });
