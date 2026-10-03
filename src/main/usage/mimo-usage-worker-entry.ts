import { readMimoDatabase } from './mimo-worker-core';
import type { MimoWorkerRequest } from './mimo-worker-protocol';
interface ParentPort {
  on(event: 'message', listener: (event: { data: MimoWorkerRequest }) => void): void;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('MiMo usage requires an isolated process port');
port.on('message', ({ data: input }) => {
  try { port.postMessage(readMimoDatabase(input)); }
  catch { port.postMessage({ job: input?.job, valid: false, fetched: 0,
    cursor: input?.cursor ?? { at: 0, id: '' }, highWatermark: 0, events: [] }); }
});
