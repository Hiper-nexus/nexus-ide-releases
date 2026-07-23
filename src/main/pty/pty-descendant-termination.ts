// Adapted from stablyai/orca @ d152039e9d6e2e2b7dfc404ec6b1a99a759af2d0.
// Copyright (c) 2026 Lovecast Inc. — MIT License.
// See third_party/licenses/orca-MIT.txt.
import { execFile } from 'node:child_process';

export const DESCENDANT_KILL_GRACE_MS = 2_000;
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000;
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps lstart` text, retained for delayed PID-reuse fencing. */
  readonly startedAt: string;
}

export interface ProcessTableCapture {
  readonly rows: readonly ProcessTableRow[];
  /** Boundary captured before the `ps` subprocess starts. */
  readonly capturedAtMs: number;
}

export interface DescendantSnapshot {
  readonly root: ProcessTableRow | null;
  readonly descendants: readonly ProcessTableRow[];
  readonly capturedAtMs: number;
}

export type ProcessTableReader = (
  timeoutMs?: number,
) => Promise<ProcessTableCapture>;
export type SignalSender = (
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
) => void;

export interface PtyProcessTreeTerminationProof {
  readonly ok: boolean;
  readonly rootExited: boolean;
  readonly descendantsExited: boolean;
  readonly error?: string;
}

interface SnapshotDependencies {
  readonly readTable?: ProcessTableReader;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

interface TerminationDependencies {
  readonly readTable?: ProcessTableReader;
  readonly sendSignal?: SignalSender;
  readonly platform?: NodeJS.Platform;
  readonly snapshotTimeoutMs?: number;
  readonly termTimeoutMs?: number;
  readonly killTimeoutMs?: number;
}

interface PtyProcessTreeTerminationInput {
  readonly rootPid: number;
  /** Exact host-side node-pty object is still current for this session. */
  readonly ownsRoot: () => boolean;
  readonly killRoot: (signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Resolves only from the exact node-pty onExit callback. */
  readonly rootExited: Promise<void>;
}

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4],
    });
  }
  return rows;
}

function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS,
): Promise<ProcessTableCapture> {
  // Identity safety uses the boundary before ps starts, not completion time.
  const capturedAtMs = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      {
        encoding: 'utf8',
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          rows: parseProcessTable(stdout),
          capturedAtMs,
        });
      },
    );
  });
}

/**
 * Coalesces requests made before a scan starts, but never gives a later caller
 * a completed/stale process table whose PIDs may already have been recycled.
 */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader,
): ProcessTableReader {
  let queued: {
    promise: Promise<ProcessTableCapture>;
    started: boolean;
  } | null = null;
  return (timeoutMs) => {
    if (queued && !queued.started) return queued.promise;
    const entry = {
      promise: Promise.resolve(undefined as never) as Promise<ProcessTableCapture>,
      started: false,
    };
    entry.promise = Promise.resolve().then(() => {
      entry.started = true;
      return readFresh(timeoutMs);
    });
    queued = entry;
    const clear = () => {
      if (queued === entry) queued = null;
    };
    void entry.promise.then(clear, clear);
    return entry.promise;
  };
}

const readProcessTable = createProcessTableSnapshotReader(
  readFreshProcessTable,
);

function readBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number,
): Promise<ProcessTableCapture | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (capture: ProcessTableCapture | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(capture);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      void readTable(timeoutMs).then(
        (capture) => finish(capture),
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  });
}

export function collectDescendantRows(
  rootPid: number,
  table: readonly ProcessTableRow[],
  capturedAtMs = Date.now(),
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>();
  const seenPids = new Set<number>();
  let root: ProcessTableRow | null = null;
  for (const row of table) {
    if (seenPids.has(row.pid)) {
      // `ps` must describe one physical identity per PID. Any duplicate,
      // including a child outside the selected tree, makes the inventory
      // internally inconsistent and therefore unusable as kill authority.
      return { root: null, descendants: [], capturedAtMs };
    }
    seenPids.add(row.pid);
    if (row.pid === rootPid) {
      root = row;
      continue;
    }
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  // A missing root means the number is vacated/reused; never seed a PPID walk
  // from a stale PID and signal unrelated processes.
  if (!root) return { root: null, descendants: [], capturedAtMs };

  const descendants: ProcessTableRow[] = [];
  const queue = [rootPid];
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenByPpid.get(queue[index]) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  return { root, descendants, capturedAtMs };
}

export async function captureDescendantSnapshot(
  rootPid: number,
  deps: SnapshotDependencies = {},
): Promise<DescendantSnapshot | null> {
  const platform = deps.platform ?? process.platform;
  if (
    platform === 'win32' ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0
  ) {
    return null;
  }
  const timeoutMs =
    deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS;
  const capture = await readBeforeDeadline(
    deps.readTable ?? readProcessTable,
    timeoutMs,
  );
  return capture
    ? collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
    : null;
}

function defaultSendSignal(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone. Final inventory, not this syscall, is the proof.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 30_000) {
    throw new Error('invalid PTY process-tree termination timeout');
  }
  return value;
}

function hasUnambiguousStartIdentity(
  row: ProcessTableRow,
  capturedAtMs: number,
): boolean {
  const startedAtMs = Date.parse(row.startedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  // `ps lstart` has second resolution. A same-second replacement cannot be
  // distinguished safely, so it is never escalated or declared gone.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000;
}

type CapturedIdentityState = 'gone' | 'live' | 'ambiguous';

function capturedIdentityState(
  expected: ProcessTableRow,
  snapshotCapturedAtMs: number,
  currentRows: readonly ProcessTableRow[],
): CapturedIdentityState {
  const matches = currentRows.filter((row) => row.pid === expected.pid);
  if (matches.length === 0) return 'gone';
  if (matches.length !== 1) return 'ambiguous';
  const current = matches[0];
  if (
    current.startedAt !== expected.startedAt ||
    current.pgid !== expected.pgid
  ) {
    return 'gone';
  }
  return hasUnambiguousStartIdentity(expected, snapshotCapturedAtMs)
    ? 'live'
    : 'ambiguous';
}

function signalDescendants(
  snapshot: DescendantSnapshot,
  signal: 'SIGTERM' | 'SIGKILL',
  sendSignal: SignalSender,
  currentRows?: readonly ProcessTableRow[],
): void {
  for (const row of snapshot.descendants) {
    if (
      currentRows &&
      capturedIdentityState(row, snapshot.capturedAtMs, currentRows) !==
        'live'
    ) {
      continue;
    }
    sendSignal(row.pid, signal);
  }
}

function proofError(
  rootExited: boolean,
  descendantsExited: boolean,
  detail: string,
): PtyProcessTreeTerminationProof {
  return Object.freeze({
    ok: false,
    rootExited,
    descendantsExited,
    error: detail,
  });
}

/**
 * Authority-critical PTY teardown. The process tree is snapshotted before the
 * root is signalled; delayed escalation is fenced by PID + lstart + PGID; the
 * result is successful only after a final bounded physical inventory proves
 * every captured descendant gone.
 *
 * No process-group-wide signal is used: `killpg` can cross authority boundaries
 * after PGID reuse. Unsupported inventory platforms deliberately fail closed.
 */
export async function terminatePtyProcessTree(
  input: PtyProcessTreeTerminationInput,
  deps: TerminationDependencies = {},
): Promise<PtyProcessTreeTerminationProof> {
  const termTimeoutMs = boundedTimeout(
    deps.termTimeoutMs,
    DESCENDANT_KILL_GRACE_MS,
  );
  const killTimeoutMs = boundedTimeout(deps.killTimeoutMs, 1_500);
  const snapshotTimeoutMs = boundedTimeout(
    deps.snapshotTimeoutMs,
    DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  );
  const readTable = deps.readTable ?? readProcessTable;
  const sendSignal = deps.sendSignal ?? defaultSendSignal;
  let rootExited = false;
  void input.rootExited.then(
    () => {
      rootExited = true;
    },
    () => {
      // A rejected callback is never physical proof.
    },
  );

  const snapshot = await captureDescendantSnapshot(input.rootPid, {
    platform: deps.platform,
    readTable,
    timeoutMs: snapshotTimeoutMs,
  });
  if (!snapshot?.root) {
    if (input.ownsRoot()) {
      try {
        input.killRoot('SIGTERM');
      } catch {
        // Continue to bounded force attempt.
      }
      await delay(termTimeoutMs);
      if (!rootExited && input.ownsRoot()) {
        try {
          input.killRoot('SIGKILL');
        } catch {
          // Root exit remains unproven.
        }
      }
      await delay(killTimeoutMs);
    }
    return proofError(
      rootExited,
      false,
      'A plataforma ou o inventário de processos não permitiu provar a saída dos descendentes.',
    );
  }
  if (!input.ownsRoot()) {
    return proofError(
      rootExited,
      false,
      'A identidade física do PTY mudou durante o snapshot; exclusividade mantida.',
    );
  }

  // Re-read immediately before the first signal. Even the short interval after
  // the ancestry snapshot is enough for a PID to exit and be recycled.
  const preTermCapture = await readBeforeDeadline(
    readTable,
    snapshotTimeoutMs,
  );
  if (preTermCapture) {
    signalDescendants(
      snapshot,
      'SIGTERM',
      sendSignal,
      preTermCapture.rows,
    );
  }
  try {
    input.killRoot('SIGTERM');
  } catch {
    // Bounded force attempt below remains authoritative.
  }
  await delay(termTimeoutMs);

  const escalationCapture = await readBeforeDeadline(
    readTable,
    snapshotTimeoutMs,
  );
  if (escalationCapture) {
    signalDescendants(
      snapshot,
      'SIGKILL',
      sendSignal,
      escalationCapture.rows,
    );
  }
  if (!rootExited && input.ownsRoot()) {
    try {
      input.killRoot('SIGKILL');
    } catch {
      // Final root callback and inventory decide the proof.
    }
  }
  await delay(killTimeoutMs);

  const finalCapture = await readBeforeDeadline(
    readTable,
    snapshotTimeoutMs,
  );
  if (!finalCapture) {
    return proofError(
      rootExited,
      false,
      'O inventário final de processos falhou; exclusividade física mantida.',
    );
  }
  const descendantsExited = snapshot.descendants.every(
    (row) =>
      capturedIdentityState(
        row,
        snapshot.capturedAtMs,
        finalCapture.rows,
      ) === 'gone',
  );
  if (!preTermCapture) {
    return proofError(
      rootExited,
      descendantsExited,
      'A revalidação de identidade pré-SIGTERM falhou; exclusividade física mantida.',
    );
  }
  if (!rootExited || !descendantsExited) {
    return proofError(
      rootExited,
      descendantsExited,
      !rootExited
        ? 'O processo raiz do PTY não produziu prova física de saída.'
        : 'Um descendente do PTY ainda está vivo ou tem identidade ambígua.',
    );
  }
  return Object.freeze({
    ok: true,
    rootExited: true,
    descendantsExited: true,
  });
}
