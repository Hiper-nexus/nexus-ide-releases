import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectDescendantRows,
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
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt };
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

describe('PTY descendant physical authority', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures a detached process-group daemon through its parent chain', () => {
    expect(parseProcessTable(
      ' 10 1 10 Mon Jul 13 12:54:47 2026\n' +
      ' 20 10 20 Mon Jul 13 12:54:47 2026\n' +
      ' 30 20 30 Mon Jul 13 12:54:47 2026\n',
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
      .mockResolvedValueOnce(capture([row(20, 10, 20), daemon]))
      .mockResolvedValueOnce(capture([daemon]))
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
    const recycled = row(30, 1, 77, 'Tue Jul 14 09:00:00 2026');
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([row(10, 1, 10), original]))
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
    const recycled = row(30, 1, 88, 'Tue Jul 14 09:00:00 2026');
    const readTable = vi.fn()
      .mockResolvedValueOnce(capture([row(10, 1, 10), original]))
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
