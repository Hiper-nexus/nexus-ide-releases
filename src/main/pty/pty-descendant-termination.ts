// Adapted from stablyai/orca @ d152039e9d6e2e2b7dfc404ec6b1a99a759af2d0.
// Copyright (c) 2026 Lovecast Inc. — MIT License.
// See third_party/licenses/orca-MIT.txt.
import { execFile } from 'node:child_process';

export const DESCENDANT_KILL_GRACE_MS = 2_000;
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000;
/** Teto de qualquer captura do `ps`: nada que ela liste nasceu mais tarde que isso. */
const MAX_SNAPSHOT_TIMEOUT_MS = 30_000;
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** POSIX session id when the platform exposes it (`0` on modern macOS). */
  readonly sid: number;
  /** Controlling terminal name, or `??`/`?` when detached. */
  readonly tty: string;
  /** `ps lstart` text, retained for delayed PID-reuse fencing. */
  readonly startedAt: string;
  /**
   * F-1479: absolute creation instant (epoch ms), set only by an inventory
   * that reports creation time in UTC (Windows CIM). `ps lstart` is local
   * wall-clock time without an offset, ambiguous across a DST fall-back, and
   * never sets it.
   */
  readonly startedAtUtcMs?: number;
}

export interface ProcessTableCapture {
  readonly rows: readonly ProcessTableRow[];
  /** Boundary captured before the `ps` subprocess starts. */
  readonly capturedAtMs: number;
}

export interface DescendantSnapshot {
  readonly root: ProcessTableRow | null;
  readonly descendants: readonly ProcessTableRow[];
  /** Full inventory used to establish closed, PTY-owned POSIX sessions. */
  readonly inventory: readonly ProcessTableRow[];
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
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/,
    );
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      sid: Number(match[4]),
      tty: match[5],
      startedAt: match[6],
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
      ['-axo', 'pid=,ppid=,pgid=,sess=,tty=,lstart='],
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
      return {
        root: null,
        descendants: [],
        inventory: table,
        capturedAtMs,
      };
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
  if (!root) {
    return {
      root: null,
      descendants: [],
      inventory: table,
      capturedAtMs,
    };
  }

  const descendants: ProcessTableRow[] = [];
  const queue = [root];
  const visited = new Set([rootPid]);
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    const parentBorn = parent.startedAtUtcMs;
    for (const child of childrenByPpid.get(parent.pid) ?? []) {
      if (visited.has(child.pid)) continue;
      // F-1435: Windows never rewrites ParentProcessId when a parent dies and
      // recycles the PID. A process born before its recorded parent is the
      // orphan of an earlier holder of that number (Chrome, Explorer, Nexus
      // itself), never a descendant. F-1479: only absolute instants compare.
      // POSIX reparents orphans, so the fence is never needed there, and its
      // local `lstart` makes a real child look older than its parent when
      // the clock falls back for DST.
      if (parentBorn !== undefined && child.startedAtUtcMs !== undefined && child.startedAtUtcMs < parentBorn) continue;
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child);
    }
  }
  return { root, descendants, inventory: table, capturedAtMs };
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
  if (!Number.isInteger(value) || value < 0 || value > MAX_SNAPSHOT_TIMEOUT_MS) {
    throw new Error('invalid PTY process-tree termination timeout');
  }
  return value;
}

/** Maior recuo de relógio de um horário de verão real (Troll: 2 h), com folga. */
const MAX_DST_FALLBACK_MS = 3 * 60 * 60_000;

function localWallClockMs(at: number): number {
  return at - new Date(at).getTimezoneOffset() * 60_000;
}

/**
 * Latest absolute instant a local `ps lstart` may denote for a row observed at
 * `observedAtMs`. On a DST fall-back the repeated hour maps to two instants
 * and `Date.parse` picks the first, so a process born in the current second
 * read an hour older (F-1479 residual). The second reading only counts when
 * the capture that listed the row could have seen it.
 */
function latestStartInstant(row: ProcessTableRow, observedAtMs: number): number {
  if (row.startedAtUtcMs !== undefined) return row.startedAtUtcMs;
  const earliest = Date.parse(row.startedAt);
  if (!Number.isFinite(earliest)) return Number.NaN;
  const later = earliest + (new Date(earliest + MAX_DST_FALLBACK_MS).getTimezoneOffset() -
    new Date(earliest).getTimezoneOffset()) * 60_000;
  return later > earliest && localWallClockMs(later) === localWallClockMs(earliest) &&
    later <= observedAtMs + MAX_SNAPSHOT_TIMEOUT_MS
    ? later
    : earliest;
}

/**
 * Same-second PID-reuse fence shared by the termination tree and the heavy
 * command claims. `ps lstart` has second resolution: a start that may fall in
 * the observed second (or later), or that cannot be read, is ambiguous.
 */
export function hasUnambiguousStartIdentity(
  row: ProcessTableRow,
  capturedAtMs: number,
): boolean {
  const startedAtMs = latestStartInstant(row, capturedAtMs);
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
  if (current.startedAt !== expected.startedAt) {
    return 'gone';
  }
  return hasUnambiguousStartIdentity(expected, snapshotCapturedAtMs)
    ? 'live'
    : 'ambiguous';
}

interface TrackedDescendant {
  readonly row: ProcessTableRow;
  readonly observedAtMs: number;
}

function processIdentityKey(row: ProcessTableRow): string {
  // PGID, SID, PPID and TTY may all change while the same process is alive.
  // PID + kernel start time is the stable identity fence available from ps.
  return `${row.pid}:${row.startedAt}`;
}

function uniqueRowsByPid(
  rows: readonly ProcessTableRow[],
): Map<number, ProcessTableRow> | null {
  const byPid = new Map<number, ProcessTableRow>();
  for (const row of rows) {
    if (byPid.has(row.pid)) return null;
    byPid.set(row.pid, row);
  }
  return byPid;
}

function addTrackedDescendant(
  tracked: Map<string, TrackedDescendant>,
  row: ProcessTableRow,
  observedAtMs: number,
): void {
  const key = processIdentityKey(row);
  if (!tracked.has(key)) {
    tracked.set(key, { row, observedAtMs });
  }
}

function establishAuthorizedSessions(
  snapshot: DescendantSnapshot,
): Set<number> {
  const treeRows = [
    ...(snapshot.root ? [snapshot.root] : []),
    ...snapshot.descendants,
  ];
  const treeKeys = new Set(treeRows.map(processIdentityKey));
  const candidates = new Set(
    treeRows
      .filter((row) => row.sid === row.pid)
      .map((row) => row.sid),
  );
  const authorized = new Set<number>();
  for (const sid of candidates) {
    const members = snapshot.inventory.filter((row) => row.sid === sid);
    if (
      members.length > 0 &&
      members.every((row) => treeKeys.has(processIdentityKey(row)))
    ) {
      authorized.add(sid);
    }
  }
  return authorized;
}

function isControllingTerminal(tty: string): boolean {
  return tty !== '?' && tty !== '??' && tty !== '-';
}

function establishAuthorizedTerminals(
  snapshot: DescendantSnapshot,
): Set<string> {
  const treeRows = [
    ...(snapshot.root ? [snapshot.root] : []),
    ...snapshot.descendants,
  ];
  const treeKeys = new Set(treeRows.map(processIdentityKey));
  const candidates = new Set(
    treeRows
      .map((row) => row.tty)
      .filter(isControllingTerminal),
  );
  const authorized = new Set<string>();
  for (const tty of candidates) {
    const members = snapshot.inventory.filter((row) => row.tty === tty);
    if (
      members.length > 0 &&
      members.every((row) => treeKeys.has(processIdentityKey(row)))
    ) {
      authorized.add(tty);
    }
  }
  return authorized;
}

/**
 * Extends kill authority only through a currently identity-fenced parent or
 * through a POSIX session / controlling terminal proven closed around this PTY
 * tree at the first inventory. Those relationships survive ordinary PPID
 * reparenting. Unknown rows are never swept merely because they share a
 * numeric process group.
 */
function discoverLateDescendants(
  rootPid: number,
  root: ProcessTableRow,
  rootObservedAtMs: number,
  tracked: Map<string, TrackedDescendant>,
  authorizedSessions: Set<number>,
  authorizedTerminals: Set<string>,
  capture: ProcessTableCapture,
): boolean {
  const byPid = uniqueRowsByPid(capture.rows);
  if (!byPid) return false;

  const childrenByPpid = new Map<number, ProcessTableRow[]>();
  for (const row of capture.rows) {
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }

  const discovered = new Map<number, ProcessTableRow>();
  const queue: ProcessTableRow[] = [];
  const enqueue = (row: ProcessTableRow): void => {
    // The root PID is controlled only through the exact node-pty handle.
    if (row.pid === rootPid || discovered.has(row.pid)) return;
    discovered.set(row.pid, row);
    queue.push(row);
  };

  if (
    capturedIdentityState(root, rootObservedAtMs, capture.rows) ===
    'live'
  ) {
    for (const child of childrenByPpid.get(rootPid) ?? []) enqueue(child);
  }
  for (const expected of tracked.values()) {
    if (
      capturedIdentityState(
        expected.row,
        expected.observedAtMs,
        capture.rows,
      ) !== 'live'
    ) {
      continue;
    }
    const current = byPid.get(expected.row.pid);
    if (!current) continue;
    enqueue(current);
    for (const child of childrenByPpid.get(current.pid) ?? []) enqueue(child);
  }
  for (const row of capture.rows) {
    if (
      authorizedSessions.has(row.sid) ||
      authorizedTerminals.has(row.tty)
    ) {
      enqueue(row);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const child of childrenByPpid.get(current.pid) ?? []) enqueue(child);
  }

  // A newly observed descendant that is itself a session leader establishes a
  // durable lineage boundary for later scans. Do not dynamically authorize a
  // different TTY: only the initially exclusive PTY slave is trusted.
  for (const row of discovered.values()) {
    addTrackedDescendant(tracked, row, capture.capturedAtMs);
    if (row.sid === row.pid) authorizedSessions.add(row.sid);
  }
  return true;
}

function signalDescendants(
  tracked: ReadonlyMap<string, TrackedDescendant>,
  signal: 'SIGTERM' | 'SIGKILL',
  sendSignal: SignalSender,
  currentRows: readonly ProcessTableRow[],
): void {
  for (const expected of tracked.values()) {
    if (
      capturedIdentityState(
        expected.row,
        expected.observedAtMs,
        currentRows,
      ) !==
        'live'
    ) {
      continue;
    }
    sendSignal(expected.row.pid, signal);
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
 * Authority-critical PTY teardown. Every bounded inventory extends the
 * authorized tree through identity-fenced parents and PTY-owned POSIX
 * sessions/terminals. This closes the one-shot snapshot gap where a late child
 * could be reparented before escalation. Delayed signals are fenced by PID +
 * lstart (PGID/SID are mutable), and success requires every identity discovered
 * during teardown to be absent from the final inventory.
 *
 * No process-group-wide signal is used: `killpg` can cross authority boundaries
 * after PGID reuse. Unsupported inventory platforms deliberately fail closed.
 */
/**
 * Mata a raiz do PTY do jeito que a plataforma aceita (F-659).
 *
 * O node-pty do Windows lança "Signals not supported on windows." para QUALQUER
 * sinal: o SIGTERM/SIGKILL deste módulo era engolido, o processo nunca morria e
 * a sessão ficava presa num voo de encerramento — saída descartada, digitação
 * recusada, Retomar/Pedir ajuste abortados por "não terminou fisicamente" e
 * pane fechado virando processo órfão. Sem sinal, o `kill()` do ConPTY fecha o
 * pseudoconsole e encerra a lista de processos do console.
 */
export function killPtyRoot(
  proc: { kill(signal?: string): void },
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    proc.kill();
    return;
  }
  proc.kill(signal);
}

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

  const tracked = new Map<string, TrackedDescendant>();
  for (const row of snapshot.descendants) {
    addTrackedDescendant(tracked, row, snapshot.capturedAtMs);
  }
  const authorizedSessions = establishAuthorizedSessions(snapshot);
  const authorizedTerminals = establishAuthorizedTerminals(snapshot);
  let inventoryReliable = true;
  const observe = async (): Promise<ProcessTableCapture | null> => {
    const capture = await readBeforeDeadline(readTable, snapshotTimeoutMs);
    if (
      !capture ||
      !discoverLateDescendants(
        input.rootPid,
        snapshot.root!,
        snapshot.capturedAtMs,
        tracked,
        authorizedSessions,
        authorizedTerminals,
        capture,
      )
    ) {
      inventoryReliable = false;
      return null;
    }
    return capture;
  };

  // Re-read immediately before the first signal. Even the short interval after
  // the ancestry snapshot is enough for a PID to exit, recycle, or fork.
  const preTermCapture = await observe();
  if (preTermCapture) {
    signalDescendants(
      tracked,
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

  // Split each grace window around a fresh inventory. A child forked by a
  // signal handler is therefore discovered and signalled within the original
  // caller-provided budget instead of adding an unbounded retry loop.
  const termFirstWaitMs = Math.floor(termTimeoutMs / 2);
  await delay(termFirstWaitMs);
  const termSweepCapture = await observe();
  if (termSweepCapture) {
    signalDescendants(
      tracked,
      'SIGTERM',
      sendSignal,
      termSweepCapture.rows,
    );
  }
  await delay(termTimeoutMs - termFirstWaitMs);

  const escalationCapture = await observe();
  if (escalationCapture) {
    signalDescendants(
      tracked,
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

  const killFirstWaitMs = Math.floor(killTimeoutMs / 2);
  await delay(killFirstWaitMs);
  const killSweepCapture = await observe();
  if (killSweepCapture) {
    signalDescendants(
      tracked,
      'SIGKILL',
      sendSignal,
      killSweepCapture.rows,
    );
  }
  await delay(killTimeoutMs - killFirstWaitMs);

  const finalCapture = await observe();
  if (!finalCapture) {
    return proofError(
      rootExited,
      false,
      'O inventário final de processos falhou; exclusividade física mantida.',
    );
  }
  const descendantsExited = [...tracked.values()].every(
    (expected) =>
      capturedIdentityState(
        expected.row,
        expected.observedAtMs,
        finalCapture.rows,
      ) === 'gone',
  );
  if (!inventoryReliable || !preTermCapture) {
    return proofError(
      rootExited,
      descendantsExited,
      'Uma revalidação de identidade durante o teardown falhou; exclusividade física mantida.',
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
