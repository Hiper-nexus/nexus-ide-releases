import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectDescendantRows,
  hasUnambiguousStartIdentity,
  killPtyRoot,
  parseProcessTable,
  terminatePtyProcessTree,
  type ProcessTableCapture,
  type ProcessTableRow,
} from './pty-descendant-termination';

const CAPTURED_AT_MS = Date.parse('Tue Jul 14 12:00:00 2026');
const STARTED_AT = 'Mon Jul 13 12:54:47 2026';

function row(
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = STARTED_AT,
  sid = 10,
  tty = 'ttys001',
): ProcessTableRow {
  return { pid, ppid, pgid, sid, tty, startedAt };
}

function capture(rows: ProcessTableRow[]): ProcessTableCapture {
  return { rows, capturedAtMs: CAPTURED_AT_MS };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('killPtyRoot no Windows (F-659)', () => {
  // O node-pty do Windows lança para QUALQUER sinal; só `kill()` fecha o ConPTY.
  function windowsPty() {
    const exited = deferred();
    const proc = {
      kill: vi.fn((signal?: string) => {
        if (signal) throw new Error('Signals not supported on windows.');
        exited.resolve();
      }),
    };
    return { proc, exited };
  }

  it('no win32 mata sem sinal; fora dele o sinal segue', () => {
    const win = { kill: vi.fn() };
    killPtyRoot(win, 'SIGTERM', 'win32');
    expect(win.kill).toHaveBeenCalledWith();
    const posix = { kill: vi.fn() };
    killPtyRoot(posix, 'SIGTERM', 'darwin');
    expect(posix.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('o encerramento prova a saída da raiz no Windows', async () => {
    const { proc, exited } = windowsPty();
    const proof = await terminatePtyProcessTree(
      {
        rootPid: 4242,
        ownsRoot: () => true,
        killRoot: (signal) => killPtyRoot(proc, signal, 'win32'),
        rootExited: exited.promise,
      },
      { platform: 'win32', termTimeoutMs: 1, killTimeoutMs: 1, snapshotTimeoutMs: 1 },
    );
    expect(proc.kill).toHaveBeenCalledWith();
    expect(proof.rootExited).toBe(true);
  });

  // F-1617: o 2º `kill()` do node-pty repete o ClosePseudoConsole no mesmo
  // HPCON e o host inteiro morre com 0xC0000374 (todos os panes caem juntos).
  it('fecha o pseudoconsole uma vez só; a escalada termina a raiz pelo PID', () => {
    const proc = { pid: 4242, kill: vi.fn() };
    const terminatePid = vi.fn();
    killPtyRoot(proc, 'SIGTERM', 'win32', terminatePid);
    killPtyRoot(proc, 'SIGTERM', 'win32', terminatePid);
    killPtyRoot(proc, undefined, 'win32', terminatePid);
    killPtyRoot(proc, 'SIGKILL', 'win32', terminatePid);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(terminatePid).toHaveBeenCalledTimes(1);
    expect(terminatePid).toHaveBeenCalledWith(4242);
  });

  it('kill que lança não abre caminho para um 2º fechamento', () => {
    const proc = {
      pid: 7,
      kill: vi.fn(() => {
        throw new Error('falha nativa');
      }),
    };
    const terminatePid = vi.fn();
    expect(() => killPtyRoot(proc, 'SIGTERM', 'win32', terminatePid)).toThrow('falha nativa');
    killPtyRoot(proc, 'SIGKILL', 'win32', terminatePid);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(terminatePid).toHaveBeenCalledWith(7);
  });

  it('escalada do encerramento com raiz lenta: um único kill() no Windows', async () => {
    const proc = { pid: 4242, kill: vi.fn() };
    const terminatePid = vi.fn();
    const exited = deferred();
    const proof = await terminatePtyProcessTree(
      {
        rootPid: 4242,
        ownsRoot: () => true,
        killRoot: (signal) => killPtyRoot(proc, signal, 'win32', terminatePid),
        rootExited: exited.promise,
      },
      { platform: 'win32', termTimeoutMs: 1, killTimeoutMs: 1, snapshotTimeoutMs: 1 },
    );
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(terminatePid).toHaveBeenCalledWith(4242);
    expect(proof.rootExited).toBe(false);
  });

  it('fora do Windows nada muda: cada pedido manda o sinal', () => {
    const proc = { pid: 9, kill: vi.fn() };
    killPtyRoot(proc, 'SIGTERM', 'linux');
    killPtyRoot(proc, 'SIGKILL', 'linux');
    killPtyRoot(proc, undefined, 'linux');
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], [undefined]]);
  });

  it('com o sinal cru (como antes) o processo nunca morria', async () => {
    const { proc, exited } = windowsPty();
    const proof = await terminatePtyProcessTree(
      {
        rootPid: 4242,
        ownsRoot: () => true,
        killRoot: (signal) => proc.kill(signal),
        rootExited: exited.promise,
      },
      { platform: 'win32', termTimeoutMs: 1, killTimeoutMs: 1, snapshotTimeoutMs: 1 },
    );
    expect(proof.rootExited).toBe(false);
  });
});

describe('PTY descendant physical authority', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures a detached process-group daemon through its parent chain', () => {
    expect(parseProcessTable(
      ' 10 1 10 10 ttys001 Mon Jul 13 12:54:47 2026\n' +
      ' 20 10 20 10 ttys001 Mon Jul 13 12:54:47 2026\n' +
      ' 30 20 30 30 ?? Mon Jul 13 12:54:47 2026\n',
    )).toHaveLength(3);
    const snapshot = collectDescendantRows(10, [
      row(10, 1, 10),
      row(20, 10, 20),
      row(30, 20, 30),
      row(31, 30, 30),
      row(99, 1, 99),
    ], CAPTURED_AT_MS);

    expect(snapshot.root?.pid).toBe(10);
    expect(snapshot.descendants.map((candidate) => [
      candidate.pid,
      candidate.pgid,
    ])).toEqual([[20, 20], [30, 30], [31, 30]]);
  });

  it('never sweeps rows behind a vacated/reused root PID', () => {
    const snapshot = collectDescendantRows(500, [
      row(501, 500, 501),
      row(502, 501, 502),
    ], CAPTURED_AT_MS);

    expect(snapshot.root).toBeNull();
    expect(snapshot.descendants).toEqual([]);
  });

  it('rejects an internally ambiguous process inventory', () => {
    const snapshot = collectDescendantRows(10, [
      row(10, 1, 10),
      row(20, 10, 20),
      row(20, 10, 99, 'Tue Jul 14 09:00:00 2026'),
    ], CAPTURED_AT_MS);

    expect(snapshot.root).toBeNull();
    expect(snapshot.descendants).toEqual([]);
  });

  it('terminates a detached daemon and proves every captured identity absent', async () => {
    const rootExit = deferred();
    const daemon = row(30, 20, 30);
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([
        row(10, 1, 10),
        row(20, 10, 20),
        daemon,
      ]))
      .mockResolvedValueOnce(capture([
        row(10, 1, 10),
        row(20, 10, 20),
        daemon,
      ]))
      .mockResolvedValueOnce(capture([row(20, 10, 20), daemon]))
      .mockResolvedValueOnce(capture([daemon]))
      .mockResolvedValueOnce(capture([]))
      .mockResolvedValueOnce(capture([]));
    const sendSignal = vi.fn();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'darwin',
      readTable,
      sendSignal,
      termTimeoutMs: 100,
      killTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [30, 'SIGTERM'],
      [20, 'SIGTERM'],
      [30, 'SIGTERM'],
      [30, 'SIGKILL'],
    ]);
    expect(killRoot.mock.calls).toEqual([
      ['SIGTERM'],
      ['SIGKILL'],
    ]);
  });

  it('does not SIGKILL a recycled PID and accepts only the changed identity as gone', async () => {
    const rootExit = deferred();
    const original = row(30, 20, 30);
    const recycled = row(
      30,
      1,
      77,
      'Tue Jul 14 09:00:00 2026',
      77,
      '?',
    );
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([row(10, 1, 10), original]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]));
    const sendSignal = vi.fn();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'linux',
      readTable,
      sendSignal,
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(sendSignal).not.toHaveBeenCalledWith(30, 'SIGTERM');
    expect(sendSignal).not.toHaveBeenCalledWith(30, 'SIGKILL');
  });

  it('never signals a PID recycled between ancestry snapshot and first SIGTERM', async () => {
    const rootExit = deferred();
    const original = row(30, 20, 30);
    const recycled = row(
      30,
      1,
      88,
      'Tue Jul 14 09:00:00 2026',
      88,
      '?',
    );
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([row(10, 1, 10), original]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]))
      .mockResolvedValueOnce(capture([recycled]));
    const sendSignal = vi.fn();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'darwin',
      readTable,
      sendSignal,
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(sendSignal).not.toHaveBeenCalledWith(30, 'SIGTERM');
    expect(sendSignal).not.toHaveBeenCalledWith(30, 'SIGKILL');
  });

  it('fails closed for a child forked after the first snapshot and reparented before exit proof', async () => {
    const rootExit = deferred();
    const macRoot = row(10, 1, 10, STARTED_AT, 0);
    const lateChild = row(40, 1, 10, STARTED_AT, 0);
    const detachedLateChild = row(40, 1, 40, STARTED_AT, 0, '?');
    const readTable = vi.fn()
      // Initial ancestry snapshot and immediate identity fence are clean.
      .mockResolvedValueOnce(capture([macRoot]))
      .mockResolvedValueOnce(capture([macRoot]))
      // The child appears only after SIGTERM. The initially exclusive PTY
      // proves lineage even though it has already been reparented from PID 10.
      .mockResolvedValueOnce(capture([macRoot, lateChild]))
      // It then detaches its TTY and changes PGID. PID + start time retain the
      // exact identity through escalation and final proof.
      .mockResolvedValueOnce(capture([detachedLateChild]))
      .mockResolvedValueOnce(capture([detachedLateChild]))
      .mockResolvedValueOnce(capture([detachedLateChild]));
    const sendSignal = vi.fn();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'darwin',
      readTable,
      sendSignal,
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: expect.stringMatching(/descendente/i),
    });
    expect(sendSignal.mock.calls).toEqual([
      [40, 'SIGTERM'],
      [40, 'SIGKILL'],
      [40, 'SIGKILL'],
    ]);
  });

  it('proves a late reparented child only after the tracked identity disappears', async () => {
    const rootExit = deferred();
    const macRoot = row(10, 1, 10, STARTED_AT, 0);
    const lateChild = row(40, 1, 10, STARTED_AT, 0);
    const detachedLateChild = row(40, 1, 40, STARTED_AT, 0, '?');
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([macRoot]))
      .mockResolvedValueOnce(capture([macRoot]))
      .mockResolvedValueOnce(capture([macRoot, lateChild]))
      .mockResolvedValueOnce(capture([detachedLateChild]))
      .mockResolvedValueOnce(capture([]))
      .mockResolvedValueOnce(capture([]));
    const sendSignal = vi.fn();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'darwin',
      readTable,
      sendSignal,
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(sendSignal.mock.calls).toEqual([
      [40, 'SIGTERM'],
      [40, 'SIGKILL'],
    ]);
  });

  it('fails closed when an intermediate late-fork inventory is unavailable', async () => {
    const rootExit = deferred();
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([row(10, 1, 10)]))
      .mockResolvedValueOnce(capture([row(10, 1, 10)]))
      .mockRejectedValueOnce(new Error('ps unavailable'))
      .mockResolvedValueOnce(capture([]))
      .mockResolvedValueOnce(capture([]))
      .mockResolvedValueOnce(capture([]));
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });

    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'linux',
      readTable,
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      rootExited: true,
      descendantsExited: true,
      error: expect.stringMatching(/revalidação/i),
    });
  });

  it('fails closed when the platform cannot prove descendant exit', async () => {
    const rootExit = deferred();
    const killRoot = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL') rootExit.resolve();
    });
    const pending = terminatePtyProcessTree({
      rootPid: 10,
      ownsRoot: () => true,
      killRoot,
      rootExited: rootExit.promise,
    }, {
      platform: 'win32',
      termTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: expect.stringMatching(/plataforma|inventário/i),
    });
  });
});

/** `ps -o lstart` (LC_ALL=C) do instante `iso` no relógio local de `zone`. */
function lstartIn(zone: string, iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.month} ${parts.day.padStart(2, ' ')} ${parts.hour}:${parts.minute}:${parts.second} ${parts.year}`;
}

/** TZ do processo controlado (o `Date.parse` do `lstart` lê a hora local). */
async function inTimeZone(zone: string, run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('F-1479 risco residual: cerca de PID reutilizado no mesmo segundo atravessa o horário de verão', () => {
  // Nascimento e observação em UTC absoluto; o `lstart` sai no relógio local da zona.
  const fence = (zone: string, bornIso: string, observedIso: string) =>
    hasUnambiguousStartIdentity(
      { pid: 20, ppid: 10, pgid: 20, sid: 0, tty: 'ttys001', startedAt: lstartIn(zone, bornIso) },
      Date.parse(observedIso),
    );

  it.each([
    // America/New_York, 1º/11/2026: 01:00–02:00 local acontece duas vezes (EDT 05–06Z, EST 06–07Z).
    ['America/New_York', '2026-11-01T06:10:00Z', '2026-11-01T06:10:00.400Z', false, '2ª ocorrência, mesmo segundo'],
    ['America/New_York', '2026-11-01T05:10:00Z', '2026-11-01T06:10:00.400Z', false, 'mesmo relógio local da 1ª ocorrência: indistinguível'],
    ['America/New_York', '2026-11-01T06:10:00Z', '2026-11-01T06:10:01.200Z', true, '2ª ocorrência, segundo seguinte'],
    ['America/New_York', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00.500Z', true, 'nasce 01:59:59 EDT, visto 01:00:00 EST'],
    ['America/New_York', '2026-11-01T05:40:00Z', '2026-11-01T06:15:00.200Z', true, 'nasce 01:40 EDT, visto 01:15 EST: 01:40 EST ainda é futuro'],
    // 8/3/2026: 02:00 EST pula para 03:00 EDT (lacuna).
    ['America/New_York', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00.500Z', true, 'atravessa a lacuna'],
    ['America/New_York', '2026-03-08T07:00:00Z', '2026-03-08T07:00:00.500Z', false, 'depois da lacuna, mesmo segundo'],
    // America/Sao_Paulo histórico: 17/2/2019 00:00 BRST voltou para 16/2 23:00 BRT (23:00–00:00 duas vezes).
    ['America/Sao_Paulo', '2019-02-17T02:30:00Z', '2019-02-17T02:30:00.300Z', false, '2ª ocorrência, mesmo segundo'],
    ['America/Sao_Paulo', '2019-02-17T01:59:59Z', '2019-02-17T02:00:00.500Z', true, 'nasce 23:59:59 BRST, visto 23:00:00 BRT'],
    // 4/11/2018: 00:00 BRT pulou para 01:00 BRST (lacuna).
    ['America/Sao_Paulo', '2018-11-04T02:59:59Z', '2018-11-04T03:00:00.500Z', true, 'atravessa a lacuna'],
    ['America/Sao_Paulo', '2018-11-04T03:00:00Z', '2018-11-04T03:00:00.500Z', false, 'depois da lacuna, mesmo segundo'],
  ])('%s: nasce %s, visto %s → inequívoco=%s (%s)', async (zone, bornIso, observedIso, unambiguous) => {
    await inTimeZone(zone, () => {
      expect(fence(zone, bornIso, observedIso)).toBe(unambiguous);
    });
  });

  it('o TZ do teste vale: na hora repetida o Date.parse lê a 1ª ocorrência', async () => {
    await inTimeZone('America/New_York', () => {
      expect(new Date(Date.parse(lstartIn('America/New_York', '2026-11-01T06:10:00Z'))).toISOString())
        .toBe('2026-11-01T05:10:00.000Z');
    });
    await inTimeZone('America/Sao_Paulo', () => {
      expect(new Date(Date.parse(lstartIn('America/Sao_Paulo', '2019-02-17T02:30:00Z'))).toISOString())
        .toBe('2019-02-17T01:30:00.000Z');
    });
  });

  it('sem leitura do lstart a cerca falha fechada; horário absoluto (Windows) compara direto', () => {
    expect(hasUnambiguousStartIdentity(row(20, 10, 20, 'not a date'), CAPTURED_AT_MS)).toBe(false);
    const at = Date.parse('2026-11-01T06:10:00.000Z');
    const windowsRow = { ...row(20, 10, 20, '2026-11-01T06:10:00.000Z'), startedAtUtcMs: at };
    expect(hasUnambiguousStartIdentity(windowsRow, at + 400)).toBe(false);
    expect(hasUnambiguousStartIdentity(windowsRow, at + 1_000)).toBe(true);
  });
});
