import { expect, it } from 'vitest';
import { OwnedCommandProcesses } from './owned-command-process';
import type { DescendantSnapshot, ProcessTableRow } from './pty-descendant-termination';
const row = (pid: number, ppid: number, startedAt = 'Sat Oct  3 12:00:00 2026'): ProcessTableRow => ({ pid, ppid, pgid: 1, sid: 1, tty: 'ttys001', startedAt });
function fixture() {
 let rows = [row(10, 1), row(20, 10)]; const identity = {};
 const capture = async (pid: number): Promise<DescendantSnapshot> => ({ root: rows.find((r) => r.pid === pid) ?? null, descendants: rows.filter((r) => r.ppid === pid), inventory: rows, capturedAtMs: Date.parse('Sat Oct  3 12:00:02 2026') });
 const tracker = new OwnedCommandProcesses((id) => id === 's' ? { pid: 10, identity } : null, capture);
 return { tracker, set: (value: ProcessTableRow[]) => { rows = value; } };
}
it('requires exact PTY ancestry and refuses external/operator PIDs', async () => {
 const { tracker } = fixture(); expect(await tracker.claim('s', 999)).toBeNull(); expect(await tracker.claim('other', 20)).toBeNull(); expect(await tracker.claim('s', 10)).toBeNull(); expect(await tracker.claim('s', 20)).toBeTypeOf('string');
});
it('holds until compiler and captured descendants disappear, including a detached child', async () => {
 const { tracker, set } = fixture(); const id = (await tracker.claim('s', 20))!;
 set([row(10, 1), row(20, 10), row(30, 20)]); expect(await tracker.probe('s', id)).toBe('live');
 set([row(10, 1), row(30, 1)]); expect(await tracker.probe('s', id)).toBe('live');
 set([row(10, 1)]); expect(await tracker.probe('s', id)).toBe('gone'); expect(await tracker.probe('s', id)).toBe('gone');
});
it('PID reuse proves only the captured compiler is gone and never captures the replacement', async () => {
 const { tracker, set } = fixture(); const id = (await tracker.claim('s', 20))!;
 set([row(10, 1), row(20, 1, 'Sat Oct  3 12:00:02 2026')]); expect(await tracker.probe('s', id)).toBe('gone'); expect(await tracker.probe('other', id)).toBe('unknown');
});

it('borrows only exact descendants of a claimed physical command and keeps that identity after reparent', async () => {
 const { tracker, set } = fixture(); const id = (await tracker.claim('s', 20))!;
 set([row(10, 1), row(20, 10), row(30, 20), row(40, 10)]);
 expect(await tracker.borrow('s', id, 40)).toBe(false);
 expect(await tracker.borrow('other', id, 30)).toBe(false);
 expect(await tracker.borrow('s', id, 30)).toBe(true);
 set([row(10, 1), row(30, 1)]); expect(await tracker.probe('s', id)).toBe('live');
 set([row(10, 1)]); expect(await tracker.probe('s', id)).toBe('gone');
});

it('borrow checks distinct identities rather than double counting captured descendants', async () => {
 const { tracker, set } = fixture(); const id = (await tracker.claim('s', 20))!;
 set([row(10, 1), row(20, 10), ...Array.from({ length: 128 }, (_, i) => row(30 + i, 20))]);
 expect(await tracker.probe('s', id)).toBe('live'); expect(await tracker.borrow('s', id, 30)).toBe(true);
});

it('borrow refuses a claim removed while its capture was pending', async () => {
 const identity = {}; let finish!: (snapshot: DescendantSnapshot) => void;
 let deferredBorrow = false;
 const live = { root: row(20, 10), descendants: [row(30, 20)], inventory: [row(10, 1), row(20, 10), row(30, 20)], capturedAtMs: Date.parse('Sat Oct  3 12:00:02 2026') };
 const tracker = new OwnedCommandProcesses(() => ({ pid: 10, identity }), async (pid) => {
  if (deferredBorrow) { deferredBorrow = false; return new Promise<DescendantSnapshot>((resolve) => finish = resolve); }
  return pid === 10 ? { ...live, root: row(10, 1), descendants: [row(20, 10)] } : { ...live, root: null, descendants: [], inventory: [row(10, 1)] };
 });
 const id = (await tracker.claim('s', 20))!;
 deferredBorrow = true; const borrowed = tracker.borrow('s', id, 30);
 expect(await tracker.probe('s', id)).toBe('gone'); finish(live);
 expect(await borrowed).toBe(false);
});
