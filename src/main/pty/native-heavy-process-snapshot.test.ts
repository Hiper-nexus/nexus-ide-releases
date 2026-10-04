import { expect, it } from 'vitest';
import { parseWindowsCommandProcesses } from './native-heavy-process-snapshot';
import { collectDescendantRows } from './pty-descendant-termination';

it('CIM birth identities prove only the exact Windows PTY descendants', () => {
 const rows = parseWindowsCommandProcesses(JSON.stringify([
   { pid: 10, ppid: 1, startedAt: '2026-10-03T20:00:00.1234567Z' },
   { pid: 20, ppid: 10, startedAt: '2026-10-03T20:00:01.1234567Z' },
   { pid: 30, ppid: 20, startedAt: '2026-10-03T20:00:02.1234567Z' },
   { pid: 40, ppid: 1, startedAt: '2026-10-03T20:00:03.1234567Z' },
 ]));
 expect(collectDescendantRows(10, rows, Date.parse('2026-10-03T20:00:05Z')).descendants.map((row) => row.pid)).toEqual([20, 30]);
 expect(rows[1].startedAt).toBe('2026-10-03T20:00:01.1234567Z');
});
it.each([
 '{}', '[{"pid":10,"ppid":1}]', '[{"pid":10,"ppid":1,"startedAt":"invalid"}]',
 '[{"pid":10,"ppid":1,"startedAt":"2026-10-03T20:00:00Z"},{"pid":10,"ppid":2,"startedAt":"2026-10-03T20:00:01Z"}]',
])('rejects incomplete/ambiguous Windows process inventory %s', (raw) => {
 expect(() => parseWindowsCommandProcesses(raw)).toThrow();
});
