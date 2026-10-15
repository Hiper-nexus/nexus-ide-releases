import { expect, it } from 'vitest';
import { OwnedCommandProcesses } from './owned-command-process';
import { collectDescendantRows, parseProcessTable, type DescendantSnapshot, type ProcessTableRow } from './pty-descendant-termination';
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
it('claim capacity stays at128 across concurrent captures after one existing claim', async () => {
 const { tracker } = fixture(); expect(await tracker.claim('s', 20)).toBeTypeOf('string');
 const results = await Promise.all(Array.from({ length: 128 }, () => tracker.claim('s', 20)));
 expect(results.filter(Boolean)).toHaveLength(127);
});
it('gone physical claims are pruned before their slots deny a new owned command', async () => {
 const { tracker, set } = fixture(); const results = await Promise.all(Array.from({ length: 128 }, () => tracker.claim('s', 20)));
 expect(results.filter(Boolean)).toHaveLength(128); set([row(10, 1), row(30, 10)]);
 expect(await tracker.claim('s', 30)).toBeTypeOf('string');
});

it('cancel only discards a tentative request, never a confirmed live physical claim', async () => {
 const { tracker } = fixture();
 const tentative = (await tracker.claimForRequest('s', 'request-tentative', 20))!;
 tracker.cancelRequest('other', 'request-tentative'); expect(await tracker.probe('s', tentative)).toBe('live');
 tracker.cancelRequest('s', 'request-tentative'); expect(await tracker.probe('s', tentative)).toBe('unknown');
 const confirmed = (await tracker.claimForRequest('s', 'request-confirmed', 20))!;
 tracker.confirmRequest('s', 'request-confirmed', confirmed); tracker.cancelRequest('s', 'request-confirmed');
 expect(await tracker.probe('s', confirmed)).toBe('live');
});

it('cancel during capture removes all128 late tentative claims without occupying host capacity', async () => {
 const identity = {}; let finish!: (snapshot: DescendantSnapshot) => void;
 const pending = new Promise<DescendantSnapshot>((resolve) => finish = resolve);
 let capturing = true;
 const snapshot = { root: row(10, 1), descendants: [row(20, 10)], inventory: [row(10, 1), row(20, 10)], capturedAtMs: Date.parse('Sat Oct  3 12:00:02 2026') };
 const tracker = new OwnedCommandProcesses(() => ({ pid: 10, identity }), async () => capturing ? pending : snapshot);
 const requests = Array.from({ length: 128 }, (_, i) => `late-${i}`);
 const results = requests.map((request) => tracker.claimForRequest('s', request, 20));
 for (const request of requests) tracker.cancelRequest('s', request);
 finish(snapshot); expect(await Promise.all(results)).toEqual(requests.map(() => null));
 capturing = false;
 expect(await tracker.claimForRequest('s', 'next', 20)).toBeTypeOf('string');
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

it('supervised claims ignore sampled disappearance until their authenticated whole job receipt', async () => {
 const identity = {}; let rows = [row(10, 1), row(20, 10)]; let state: 'live' | 'gone' | 'unknown' = 'live';
 const capture = async (pid: number): Promise<DescendantSnapshot> => ({ root: rows.find((r) => r.pid === pid) ?? null, descendants: rows.filter((r) => r.ppid === pid), inventory: rows, capturedAtMs: Date.parse('Sat Oct  3 12:00:02 2026') });
 const tracker = new OwnedCommandProcesses(() => ({ pid: 10, identity }), capture, async () => ({ state: () => state, borrow: async () => false }));
 const claim = (await tracker.claim('s', 20, 'darwin-job'))!; expect(claim).toBeTypeOf('string');
 rows = [row(10, 1)]; expect(await tracker.probe('s', claim)).toBe('live');
 state = 'unknown'; expect(await tracker.probe('s', claim)).toBe('unknown');
 state = 'gone'; expect(await tracker.probe('s', claim)).toBe('gone');
});

it('F-1435: um órfão antigo com o PPID reciclado não segura a vaga depois que o comando sai', async () => {
 // Real walk (collectDescendantRows) over Windows-shaped rows: the job's child
 // 30 got a recycled PID that an hours-old process still names as its parent.
 const at = (time: string): ProcessTableRow => ({ pid: 0, ppid: 0, pgid: 0, sid: 0, tty: '?', startedAt: `2026-10-13T${time}Z`, startedAtUtcMs: Date.parse(`2026-10-13T${time}Z`) });
 const proc = (pid: number, ppid: number, time: string): ProcessTableRow => ({ ...at(time), pid, ppid });
 const pane = proc(10, 1, '18:00:00.000'), browser = proc(90, 30, '09:00:00.000'), tab = proc(91, 90, '09:00:01.000');
 let table = [pane, proc(20, 10, '19:00:00.000'), browser, tab];
 const capture = async (pid: number): Promise<DescendantSnapshot> => collectDescendantRows(pid, table, Date.parse('2026-10-13T19:00:05Z'));
 const tracker = new OwnedCommandProcesses((id) => id === 's' ? { pid: 10, identity: pane } : null, capture);
 const id = (await tracker.claim('s', 20))!; expect(id).toBeTypeOf('string');
 table = [pane, proc(20, 10, '19:00:00.000'), proc(30, 20, '19:00:02.000'), browser, tab];
 expect(await tracker.probe('s', id)).toBe('live');
 table = [pane, browser, tab];
 expect(await tracker.probe('s', id)).toBe('gone');
});

it('F-1479: na volta do horário de verão o filho real com `lstart` "anterior" ao pai segura a vaga depois que o pai sai', async () => {
 // `ps lstart` sai na hora local, sem offset. Formatada com a zona IANA fixa
 // (não depende do TZ de quem roda o teste): em America/New_York, 2026-11-01,
 // o pai nasce 05:50Z (01:50 EDT) e o filho 06:10Z (01:10 EST).
 const parts = (iso: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
   weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
   .formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
 const lstart = (iso: string) => { const p = parts(iso); return `${p.weekday} ${p.month} ${p.day.padStart(2, ' ')} ${p.hour}:${p.minute}:${p.second} ${p.year}`; };
 expect([lstart('2026-11-01T05:50:00Z'), lstart('2026-11-01T06:10:00Z')]).toEqual(['Sun Nov  1 01:50:00 2026', 'Sun Nov  1 01:10:00 2026']);
 const ps = (...lines: Array<[number, number, string]>) => parseProcessTable(lines.map(([pid, ppid, iso]) => `${pid} ${ppid} ${pid} ${pid} ttys001 ${lstart(iso)}`).join('\n'));
 const pane: [number, number, string] = [10, 1, '2026-11-01T05:00:00Z'], job: [number, number, string] = [20, 10, '2026-11-01T05:50:00Z'];
 let table = ps(pane, job);
 // Bem depois de qualquer leitura local dessas horas, em qualquer TZ do runner.
 const capture = async (pid: number): Promise<DescendantSnapshot> => collectDescendantRows(pid, table, Date.parse('2026-11-02T12:00:00Z'));
 const tracker = new OwnedCommandProcesses((id) => id === 's' ? { pid: 10, identity: pane } : null, capture);
 const id = (await tracker.claim('s', 20))!; expect(id).toBeTypeOf('string');
 table = ps(pane, job, [30, 20, '2026-11-01T06:10:00Z']);
 expect(await tracker.probe('s', id)).toBe('live');
 table = ps(pane, [30, 1, '2026-11-01T06:10:00Z']);
 expect(await tracker.probe('s', id)).toBe('live');
 table = ps(pane);
 expect(await tracker.probe('s', id)).toBe('gone');
});

it('F-1479 risco residual: na hora repetida o claim recusa o processo nascido no segundo observado', async () => {
 // TZ controlado: `ps lstart` é relógio local de America/New_York e o Date.parse lê a 1ª ocorrência.
 const zone = 'America/New_York';
 const parts = (iso: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
   weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
   .formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
 const lstart = (iso: string) => { const p = parts(iso); return `${p.weekday} ${p.month} ${p.day.padStart(2, ' ')} ${p.hour}:${p.minute}:${p.second} ${p.year}`; };
 const ps = (...lines: Array<[number, number, string]>) => parseProcessTable(lines.map(([pid, ppid, iso]) => `${pid} ${ppid} ${pid} ${pid} ttys001 ${lstart(iso)}`).join('\n'));
 const previous = process.env.TZ;
 process.env.TZ = zone;
 try {
   const pane: [number, number, string] = [10, 1, '2026-11-01T05:00:00Z'];
   // 01:10:00 EST (2ª ocorrência), visto 400 ms depois: o PID pode ter sido reutilizado neste segundo.
   const sameSecond = ps(pane, [20, 10, '2026-11-01T06:10:00Z']);
   const tracker = new OwnedCommandProcesses((id) => id === 's' ? { pid: 10, identity: pane } : null,
     async (pid) => collectDescendantRows(pid, sameSecond, Date.parse('2026-11-01T06:10:00.400Z')));
   expect(await tracker.claim('s', 20)).toBeNull();
   // Um segundo antes o nascimento é inequívoco: o claim sai.
   const earlier = ps(pane, [20, 10, '2026-11-01T06:09:59Z']);
   const control = new OwnedCommandProcesses((id) => id === 's' ? { pid: 10, identity: pane } : null,
     async (pid) => collectDescendantRows(pid, earlier, Date.parse('2026-11-01T06:10:00.400Z')));
   expect(await control.claim('s', 20)).toBeTypeOf('string');
 } finally {
   if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
 }
});
