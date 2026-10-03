import { expect, it } from 'vitest';
import { parseMimoWorkerReply } from './mimo-worker-protocol';
const base = { job: 1, valid: true, fetched: 0, cursor: { at: 0, id: '' }, highWatermark: 0, events: [] };
it('refuses oversized collections and raw transcript fields before any Main consumer', () => {
  expect(parseMimoWorkerReply({ ...base, events: new Array(129).fill({}) })).toBeNull();
  expect(parseMimoWorkerReply({ ...base, rawTranscript: 'private answer' })).toBeNull();
  expect(parseMimoWorkerReply({ ...base, fetched: 129 })).toBeNull();
  expect(parseMimoWorkerReply(base)).toEqual(base);
});
