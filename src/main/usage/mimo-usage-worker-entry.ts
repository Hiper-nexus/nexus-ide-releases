import { parentPort } from 'node:worker_threads';
import { readMimoDatabase } from './mimo-worker-core';
import type { MimoWorkerRequest } from './mimo-worker-protocol';
const port = parentPort;
if (!port) throw new Error('MiMo usage requires a worker port');
port.on('message', (input: MimoWorkerRequest) => {
  try { port.postMessage(readMimoDatabase(input)); }
  catch { port.postMessage({ job: input?.job, valid: false, fetched: 0,
    cursor: input?.cursor ?? { at: 0, id: '' }, highWatermark: 0, events: [] }); }
});
