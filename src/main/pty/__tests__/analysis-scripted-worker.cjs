const { parentPort } = require('node:worker_threads');
parentPort.on('message', (record) => {
  parentPort.postMessage({ kind: 'work-start', sessionId: record.sessionId, workerEpoch: record.workerEpoch, job: record.eventSeq });
  if (record.kind === 'data' && record.data.startsWith('poison:')) {
    /^(a+)+$/u.test(record.data.slice(7));
  }
  const events = record.kind === 'data' ? [{ consumer: 'prompt', registration: 1, value: { response: 'old-generation-response' } }] : [];
  const reply = { ...record, kind: 'result', done: true, ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0, events };
  if (record.kind === 'data') setTimeout(() => parentPort.postMessage(reply), 100);
  else parentPort.postMessage(reply);
});
parentPort.postMessage({ kind: 'ready' });
