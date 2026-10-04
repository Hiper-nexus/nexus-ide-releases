import type { CommandProcessState } from './owned-command-process';
/**
 * PTY host protocol + main-side dispatcher — pure logic, no electron / node-pty
 * imports so it unit-tests directly under vitest (same convention as
 * pane-pipe-core.ts). The native @lydell/node-pty addon runs in an isolated
 * utilityProcess (docs/ARCHITECTURE.md §B.2); this module owns the message
 * contract and the bookkeeping that turns host events back into per-session
 * callbacks. pty-host-client.ts wires it to the real utilityProcess.
 */
import type { PtyProcessTreeTerminationProof } from './pty-descendant-termination';
import type { SessionFootprint } from './pane-footprint';
import type {
  DarwinPtyExecutableSeal,
  SupervisedPtyCommand,
} from './darwin-pty-supervisor';
import type {
  DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
} from './darwin-pty-supervisor';

/** Fully-resolved spawn request. The main process builds file/args/env (the
 * security-relevant work); the host only executes it. */
export interface PtySpawnSpec {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  /**
   * Main-authenticated Mach-O identity. On Darwin the utility host must route
   * this through the native suspended/live-code verifier; it is never advisory.
   */
  darwinExecutableSeal?: DarwinPtyExecutableSeal;
  /**
   * Main-owned, single-purpose authority for the packaged smoke probe. It is
   * never derived from environment variables and cannot authorize a CLI.
   */
  darwinTrustProfile?: typeof DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE;
}

export type PtyKillSignal = 'SIGTERM' | 'SIGKILL';

/** main → host (control). */
export type HostControlMsg =
  | ({ type: 'spawn' } & PtySpawnSpec)
  | { type: 'prepare-command'; requestId: string; file: string; args: string[] }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string; signal?: PtyKillSignal }
  | { type: 'analysis-credit'; sessionId: string; bytes: number }
  | { type: 'output-flow'; sessionId: string; paused: boolean }
  | { type: 'command-process-confirm'; requestId: string; sessionId: string; claimId: string }
  | { type: 'command-process-cancel'; requestId: string; sessionId: string }
  | { type: 'command-process'; requestId: string; sessionId: string; op: 'claim'; pid: number; proof?: 'darwin-job' }
  | { type: 'prepare-native-heavy-job-base'; requestId: string }
  | { type: 'command-process'; requestId: string; sessionId: string; op: 'probe' | 'stop'; claimId: string }
  | { type: 'command-process'; requestId: string; sessionId: string; op: 'borrow'; claimId: string; pid: number }
  | {
      type: 'terminate';
      sessionId: string;
      requestId: string;
      termTimeoutMs: number;
      killTimeoutMs: number;
    }
  | { type: 'liveness-probe'; requestId: string; sessionIds: string[] }
  /** F-572: RSS da árvore de processos de cada sessão viva no host. */
  | { type: 'footprint-probe'; requestId: string };

/** host → main (events). */
export type HostEventMsg =
  | { type: 'prepared-command'; requestId: string; command: SupervisedPtyCommand | null }
  | { type: 'native-heavy-job-base'; requestId: string; command: import('./darwin-pty-supervisor').SupervisedPtyCommand | null }
  | { type: 'command-process-result'; stopped?: boolean; requestId: string; sessionId: string; claimId: string | null; state: CommandProcessState | null; borrowed?: boolean }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; signal?: number }
  | {
      type: 'termination-result';
      sessionId: string;
      requestId: string;
      proof: PtyProcessTreeTerminationProof;
    }
  | { type: 'liveness-report'; requestId: string; live: string[] }
  | {
      type: 'footprint-report';
      requestId: string;
      footprints: SessionFootprint[];
    };

export interface PtySessionHandlers {
  onData: (data: string) => void;
  onExit: (exitCode: number, signal?: number) => void;
}

/**
 * Per-session proxy handed back to pty-manager in place of a raw node-pty
 * `IPty`. Every method just posts a control message to the host — the renderer
 * and orchestration layer never hold a real terminal handle.
 */
export interface PtyProcHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: PtyKillSignal): void;
  acknowledgeOutput?(bytes: number): void;
  setOutputPaused?(paused: boolean): void;
  terminate(options: {
    readonly termTimeoutMs: number;
    readonly killTimeoutMs: number;
  }): Promise<PtyProcessTreeTerminationProof>;
}

export interface PtyHost {
  prepareCommandSupervisor?(file: string, args: readonly string[]): Promise<SupervisedPtyCommand | null>;
  borrowCommandProcess?(sessionId: string, claimId: string, pid: number): Promise<boolean>;
  claimCommandProcess?(sessionId: string, pid: number, proof?: 'darwin-job'): Promise<string | null>;
  prepareNativeHeavyJobBase?(): Promise<import('./darwin-pty-supervisor').SupervisedPtyCommand | null>;
  probeCommandProcess?(sessionId: string, claimId: string): Promise<CommandProcessState>;
  stopCommandProcess?(sessionId: string, claimId: string): Promise<void>;
  spawn(spec: PtySpawnSpec, handlers: PtySessionHandlers, readiness?: PtySpawnReadiness): PtyProcHandle;
  /**
   * Pergunta ao host quais destas sessões têm handle vivo no seu mapa.
   * `null` = host não respondeu (mudo/timeout) — unverifiable, NUNCA morte.
   * Opcional: fakes de teste sem mortalidade não precisam implementar.
   */
  probeLiveness?(
    sessionIds: readonly string[],
  ): Promise<ReadonlySet<string> | null>;
  /**
   * F-572: footprint (RSS da árvore de processos) de cada sessão viva no host.
   * `null` = host não respondeu ou plataforma sem `ps` — telemetria ausente,
   * nunca pressão inventada. Opcional: fakes de teste não precisam implementar.
   */
  probeFootprints?(): Promise<readonly SessionFootprint[] | null>;
}
/** Main-only preparation; never included in HostControlMsg/renderer IPC. */
export interface PtySpawnReadiness {
  wait: Promise<{ args?: readonly string[]; env?: Readonly<Record<string, string>> }>;
  assertCurrent(): void;
  cleanup(): Promise<void>;
}

/** Transport over the utilityProcess. `ensure()` lazily (re)forks the child. */
export interface HostTransport {
  ensure(): void;
  post(msg: HostControlMsg): void;
}

export interface PtyHostBridge {
  host: PtyHost;
  /** Feed one host→main event to the owning session's callbacks. */
  dispatchEvent(msg: HostEventMsg): void;
  /**
   * The child died: publish root loss exactly once. Authority-critical callers
   * still fail closed until a separate descendant proof succeeds.
   */
  handleHostDown(): void;
  /** Live session count (tests / diagnostics). */
  sessionCount(): number;
}


const TERMINATION_PROCESS_SCAN_BUDGET_MS = 4_000;
const TERMINATION_TRANSPORT_MARGIN_MS = 500;
/** Janela do probe de mortalidade; estourou = unverifiable, nunca morte. */
const LIVENESS_PROBE_TIMEOUT_MS = 3_000;
/** F-572: `ps` na árvore inteira cabe folgado; host mudo vira null. */
const FOOTPRINT_PROBE_TIMEOUT_MS = 4_000;
const pendingFootprintProbes = new Map<
  string,
  {
    resolve: (value: readonly SessionFootprint[] | null) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }
>();
let footprintProbeCounter = 0;
export const PRE_SPAWN_FAILURE_TOMBSTONE_TTL_MS = 120_000;
export const PRE_SPAWN_FAILURE_TOMBSTONE_LIMIT = 256;
export const PHYSICAL_EXIT_RECEIPT_TTL_MS = 300_000;
export const PHYSICAL_EXIT_RECEIPT_LIMIT = 512;

interface PreSpawnFailureTombstoneOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * Bounded, short-lived host evidence that a specific session failed before
 * nodePty.spawn was called. This is intentionally one-shot: it may prove an
 * empty process tree for that exact session once, but an arbitrary missing
 * session remains a fail-closed termination.
 */
export class PreSpawnFailureTombstones {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: PreSpawnFailureTombstoneOptions = {}) {
    this.ttlMs = options.ttlMs ?? PRE_SPAWN_FAILURE_TOMBSTONE_TTL_MS;
    this.maxEntries =
      options.maxEntries ?? PRE_SPAWN_FAILURE_TOMBSTONE_LIMIT;
    this.now = options.now ?? Date.now;
    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries <= 0
    ) {
      throw new Error('invalid pre-spawn failure tombstone bounds');
    }
  }

  record(sessionId: string): void {
    const now = this.now();
    this.prune(now);
    this.entries.delete(sessionId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(sessionId, now + this.ttlMs);
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  consume(sessionId: string): boolean {
    this.prune(this.now());
    if (!this.entries.has(sessionId)) return false;
    this.entries.delete(sessionId);
    return true;
  }

  size(): number {
    this.prune(this.now());
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [sessionId, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(sessionId);
    }
  }
}

interface PhysicalExitReceiptOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface PhysicalExitReceipt {
  readonly proof: PtyProcessTreeTerminationProof;
  readonly expiresAt: number;
}

/**
 * Stable, bounded host evidence for a process tree whose exact native
 * supervisor has already exited. A terminate request can arrive one event-loop
 * turn after node-pty's exit callback (or be retried by Main); deleting the
 * host entry must not turn that proven cohort into an "unknown session".
 *
 * Only complete root+descendant proofs are accepted. Unlike the negative
 * pre-spawn fact above, a physical exit receipt is deliberately reusable:
 * retries ask about the same immutable, opaque session id and must receive the
 * same answer until Main has crossed its shutdown fence.
 */
export class PhysicalExitReceipts {
  private readonly entries = new Map<string, PhysicalExitReceipt>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: PhysicalExitReceiptOptions = {}) {
    this.ttlMs = options.ttlMs ?? PHYSICAL_EXIT_RECEIPT_TTL_MS;
    this.maxEntries = options.maxEntries ?? PHYSICAL_EXIT_RECEIPT_LIMIT;
    this.now = options.now ?? Date.now;
    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries <= 0
    ) {
      throw new Error('invalid physical-exit receipt bounds');
    }
  }

  record(
    sessionId: string,
    proof: PtyProcessTreeTerminationProof,
  ): void {
    if (!proof.ok || !proof.rootExited || !proof.descendantsExited) return;
    const now = this.now();
    this.prune(now);
    this.entries.delete(sessionId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(sessionId, {
      proof: Object.freeze({
        ok: true,
        rootExited: true,
        descendantsExited: true,
      }),
      expiresAt: now + this.ttlMs,
    });
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  read(sessionId: string): PtyProcessTreeTerminationProof | null {
    this.prune(this.now());
    return this.entries.get(sessionId)?.proof ?? null;
  }

  size(): number {
    this.prune(this.now());
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [sessionId, receipt] of this.entries) {
      if (receipt.expiresAt <= now) this.entries.delete(sessionId);
    }
  }
}

/** A node-pty exit as observed by the host. */
export interface PtyExitObservation {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface DarwinSupervisorEscalationOptions {
  /** Grace after SIGTERM before the root is force-killed. */
  readonly termGraceMs: number;
  /** Grace after SIGKILL before the wait is abandoned (never hangs). */
  readonly killGraceMs: number;
  /** Post a signal to the node-pty root (host: `entry.proc.kill`). */
  readonly sendSignal: (signal: PtyKillSignal) => void;
  /** Resolves once node-pty reports the root's exit. */
  readonly exitObservation: Promise<PtyExitObservation>;
  /** Canonical Darwin responsibility-supervisor receipt predicate. */
  readonly isProvenExit: (observation: PtyExitObservation) => boolean;
  /** Injected timer so the state machine is unit-testable under fake timers. */
  readonly delay: (ms: number) => Promise<void>;
}

function proofFromDarwinObservation(
  observation: PtyExitObservation,
  isProvenExit: (observation: PtyExitObservation) => boolean,
): PtyProcessTreeTerminationProof {
  if (isProvenExit(observation)) {
    return { ok: true, rootExited: true, descendantsExited: true };
  }
  // Root is gone (observation resolved) but the receipt is non-canonical:
  // surface rootExited so Main can finish its quit inventory, never claim
  // descendantsExited without the signed cohort receipt.
  return {
    ok: false,
    rootExited: true,
    descendantsExited: false,
    error:
      `O supervisor Darwin saiu sem recibo canônico ` +
      `(exitCode=${String(observation.exitCode)}, ` +
      `signal=${String(observation.signal ?? 'none')}).`,
  };
}

/**
 * Bounded SIGTERM→SIGKILL escalation over the signed Darwin responsibility
 * supervisor's clean-exit receipt. Historically this waited on the supervisor's
 * exit UNBOUNDED (docs: v0.25.0 quit-hang) — a single stuck-but-alive child PTY
 * that never posted its exit pinned app quit forever. It now escalates and
 * ALWAYS resolves: the exact receipt still wins whenever it arrives inside the
 * grace windows (preserving "elapsed time is not proof"), but an unresponsive
 * root is force-killed and, past the final grace, settled fail-closed so quit
 * can proceed instead of hanging. Pure/injectable so the machine unit-tests.
 */
export async function escalateDarwinSupervisorTermination(
  options: DarwinSupervisorEscalationOptions,
): Promise<PtyProcessTreeTerminationProof> {
  const { termGraceMs, killGraceMs, sendSignal, exitObservation, isProvenExit, delay } =
    options;
  const TIMED_OUT = Symbol('darwin-termination-grace');
  const observedWithin = (
    ms: number,
  ): Promise<PtyExitObservation | typeof TIMED_OUT> =>
    Promise.race([
      exitObservation,
      delay(ms).then((): typeof TIMED_OUT => TIMED_OUT),
    ]);

  try {
    sendSignal('SIGTERM');
  } catch (error) {
    return {
      ok: false,
      rootExited: false,
      descendantsExited: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const afterTerm = await observedWithin(termGraceMs);
  if (afterTerm !== TIMED_OUT) {
    return proofFromDarwinObservation(afterTerm, isProvenExit);
  }

  // The supervisor did not exit within the grace: force-kill the root. At quit
  // the host is about to be destroyed anyway, so bounding here beats hanging.
  try {
    sendSignal('SIGKILL');
  } catch {
    // Root may already be gone; fall through to the final observation wait.
  }

  const afterKill = await observedWithin(killGraceMs);
  if (afterKill !== TIMED_OUT) {
    return proofFromDarwinObservation(afterKill, isProvenExit);
  }

  return {
    ok: false,
    rootExited: false,
    descendantsExited: false,
    error:
      'O supervisor Darwin não confirmou término dentro do prazo de quit; ' +
      'SIGKILL foi emitido e a espera foi abandonada para não travar a saída.',
  };
}

/**
 * Build the main-side bridge. `dispatchEvent`/`handleHostDown` are driven by the
 * client from the utilityProcess's message/exit events; `host.spawn` is called
 * by pty-manager. A session's handlers are dropped on its first `exit` so a
 * later duplicate (e.g. our own kill echoing back) is a no-op — the idempotency
 * the exit path depends on.
 */
export function createPtyHostBridge(
  transport: HostTransport,
): PtyHostBridge {
  const handlers = new Map<string, PtySessionHandlers>();
  const reservations = new Map<string, object>();
  const pendingSpawns = new Map<object, { sessionId: string; cancel(): Promise<void> }>();
  const pendingTerminations = new Map<
    string,
    {
      readonly sessionId: string;
      readonly resolve: (proof: PtyProcessTreeTerminationProof) => void;
      readonly timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  let terminationCounter = 0;
  const pendingLivenessProbes = new Map<
    string,
    {
      readonly resolve: (live: ReadonlySet<string> | null) => void;
      readonly timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  let livenessProbeCounter = 0;

  let commandCounter = 0;
  const pendingPreparations = new Map<string, { resolve: (value: SupervisedPtyCommand | null) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingCommands = new Map<string, { sessionId: string; claim: boolean; resolve: (result: Extract<HostEventMsg, { type: 'command-process-result' }> | null) => void; timer: ReturnType<typeof setTimeout> }>();
  function commandRequest(body: { op: 'claim'; pid: number; proof?: 'darwin-job' } | { op: 'probe' | 'stop'; claimId: string } | { op: 'borrow'; claimId: string; pid: number }, sessionId: string) {
    if (pendingCommands.size >= 128) return Promise.resolve(null);
    const requestId = `pty-command-${++commandCounter}`;
    return new Promise<Extract<HostEventMsg, { type: 'command-process-result' }> | null>((resolve) => {
      const timer = setTimeout(() => { if (pendingCommands.delete(requestId)) { if (body.op === 'claim') { try { transport.post({ type: 'command-process-cancel', requestId, sessionId }); } catch {} } resolve(null); } }, body.op === 'stop' ? 15_000 : 2_000); timer.unref?.();
      pendingCommands.set(requestId, { sessionId, claim: body.op === 'claim', resolve, timer });
      try { transport.post({ type: 'command-process', requestId, sessionId, ...body }); }
      catch { pendingCommands.delete(requestId); clearTimeout(timer); resolve(null); }
    });
  }
  const pendingJobBases = new Map<string, { resolve: (command: import('./darwin-pty-supervisor').SupervisedPtyCommand | null) => void; timer: ReturnType<typeof setTimeout> }>();
  const host: PtyHost = {
    prepareCommandSupervisor: (file, args) => {
      if (pendingPreparations.size >= 32 || !file || file.length > 4096 || file.includes('\0') ||
          args.length > 1024 || args.some(arg => arg.length > 65536 || arg.includes('\0')) ||
          args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 1024 * 1024) return Promise.resolve(null);
      const requestId = `pty-prepare-${++commandCounter}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pendingPreparations.delete(requestId)) resolve(null); }, 8_000); timer.unref?.();
        pendingPreparations.set(requestId, { resolve, timer });
        try { transport.ensure(); transport.post({ type: 'prepare-command', requestId, file, args: [...args] }); }
        catch { pendingPreparations.delete(requestId); clearTimeout(timer); resolve(null); }
      });
    },
    prepareNativeHeavyJobBase: () => new Promise((resolve) => {
      const requestId = `heavy-job-base-${++commandCounter}`;
      const timer = setTimeout(() => { pendingJobBases.delete(requestId); resolve(null); }, 15_000); timer.unref?.();
      pendingJobBases.set(requestId, { resolve, timer });
      try { transport.ensure(); transport.post({ type: 'prepare-native-heavy-job-base', requestId }); }
      catch { clearTimeout(timer); pendingJobBases.delete(requestId); resolve(null); }
    }),
    borrowCommandProcess: async (sessionId, claimId, pid) => (await commandRequest({ op: 'borrow', claimId, pid }, sessionId))?.borrowed === true,
    claimCommandProcess: async (sessionId, pid, proof) => (await commandRequest({ op: 'claim', pid, ...(proof ? { proof } : {}) }, sessionId))?.claimId ?? null,
    stopCommandProcess: async (sessionId, claimId) => { if ((await commandRequest({ op: 'stop', claimId }, sessionId))?.stopped !== true) throw new Error('native_heavy_authority_exit_unproved'); },
    probeCommandProcess: async (sessionId, claimId) => (await commandRequest({ op: 'probe', claimId }, sessionId))?.state ?? 'unknown',
    spawn(spec, h, readiness) {
      handlers.set(spec.sessionId, h);
      const reservation = {}; reservations.set(spec.sessionId, reservation);
      transport.ensure();
      const sealed = { ...spec, args: [...spec.args], env: { ...spec.env } };
      let posted = false, cancelled = false, cleanup: Promise<void> | undefined;
      const cancelBeforeBirth = () => {
        if (posted) return Promise.resolve();
        cancelled = true;
        cleanup ??= readiness?.cleanup() ?? Promise.resolve();
        return cleanup.then(() => { pendingSpawns.delete(reservation); if (reservations.get(spec.sessionId) === reservation) { reservations.delete(spec.sessionId); handlers.delete(spec.sessionId); h.onExit(1); } }, error => { cleanup = undefined; throw error; });
      };
      if (readiness) {
        pendingSpawns.set(reservation, { sessionId: spec.sessionId, cancel: cancelBeforeBirth });
        void readiness.wait.then(patch => {
          if (cancelled || reservations.get(spec.sessionId) !== reservation || handlers.get(spec.sessionId) !== h) return cancelBeforeBirth();
          readiness.assertCurrent();
          if (patch.args) sealed.args = [...patch.args];
          if (patch.env) {
            const permitted = new Set(['NEXUS_HEAVY_CHANNEL_DIR', 'NEXUS_HEAVY_CHANNEL_KEY', 'NEXUS_HEAVY_CHANNEL_EPOCH', 'NEXUS_HEAVY_CHANNEL_PUBLIC_KEY']);
            if (Object.keys(patch.env).some(key => !permitted.has(key))) throw new Error('invalid deferred spawn environment');
            Object.assign(sealed.env, patch.env);
          }
          transport.post({ type: 'spawn', ...sealed }); posted = true; pendingSpawns.delete(reservation);
          return undefined;
        }).catch(() => cancelBeforeBirth()).catch(() => { /* retained unknown cleanup, terminate can retry */ });
      } else { posted = true; transport.post({ type: 'spawn', ...sealed }); }
      return {
        acknowledgeOutput: (bytes) => transport.post({ type: 'analysis-credit', sessionId: spec.sessionId, bytes }),
        setOutputPaused: (paused) => transport.post({ type: 'output-flow', sessionId: spec.sessionId, paused }),
        write: (data) =>
          transport.post({ type: 'write', sessionId: spec.sessionId, data }),
        resize: (cols, rows) =>
          transport.post({ type: 'resize', sessionId: spec.sessionId, cols, rows }),
        kill: (signal) => {
          if (!posted) { void cancelBeforeBirth().catch(() => {}); return; }
          transport.post({
            type: 'kill',
            sessionId: spec.sessionId,
            ...(signal ? { signal } : {}),
          }); },
        terminate: ({ termTimeoutMs, killTimeoutMs }) => {
          if (!posted) return cancelBeforeBirth().then(() => ({ ok: true, rootExited: true, descendantsExited: true }), error => ({ ok: false, rootExited: true, descendantsExited: false, error: error instanceof Error ? error.message : String(error) }));
          const requestId =
            `pty-termination-${Date.now().toString(36)}-${++terminationCounter}`;
          return new Promise<PtyProcessTreeTerminationProof>((resolve) => {
            // Bounded on EVERY platform. The transport deadline is strictly
            // larger than the host's own SIGTERM→SIGKILL escalation window
            // (termTimeoutMs + killTimeoutMs), so the exact host receipt still
            // wins the normal race; this timer only fires if the host PROCESS
            // itself is wedged and never posts. It used to be null on Darwin —
            // a stuck host then hung app quit forever (v0.25.0 blocker).
            const deadlineMs =
              termTimeoutMs +
              killTimeoutMs +
              TERMINATION_PROCESS_SCAN_BUDGET_MS +
              TERMINATION_TRANSPORT_MARGIN_MS;
            const timer = setTimeout(() => {
              const pending = pendingTerminations.get(requestId);
              if (!pending || pending.sessionId !== spec.sessionId) return;
              pendingTerminations.delete(requestId);
              resolve({
                ok: false,
                rootExited: false,
                descendantsExited: false,
                error:
                  'O PTY host não respondeu dentro da janela física de término.',
              });
            }, deadlineMs);
            timer.unref?.();
            pendingTerminations.set(requestId, {
              sessionId: spec.sessionId,
              resolve,
              timer,
            });
            try {
              transport.post({
                type: 'terminate',
                sessionId: spec.sessionId,
                requestId,
                termTimeoutMs,
                killTimeoutMs,
              });
            } catch (error) {
              const pending = pendingTerminations.get(requestId);
              if (pending?.timer) clearTimeout(pending.timer);
              pendingTerminations.delete(requestId);
              resolve({
                ok: false,
                rootExited: false,
                descendantsExited: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'PTY host termination request failed',
              });
            }
          });
        },
      };
    },
    probeFootprints() {
      const requestId = `pty-footprint-${++footprintProbeCounter}`;
      return new Promise<readonly SessionFootprint[] | null>((resolve) => {
        const timer = setTimeout(() => {
          if (!pendingFootprintProbes.delete(requestId)) return;
          resolve(null); // host mudo = telemetria ausente, nunca pressão
        }, FOOTPRINT_PROBE_TIMEOUT_MS);
        timer.unref?.();
        pendingFootprintProbes.set(requestId, { resolve, timer });
        try {
          transport.post({ type: 'footprint-probe', requestId });
        } catch {
          if (pendingFootprintProbes.delete(requestId)) {
            clearTimeout(timer);
            resolve(null);
          }
        }
      });
    },
    probeLiveness(sessionIds) {
      const requestId = `pty-liveness-${++livenessProbeCounter}`;
      return new Promise<ReadonlySet<string> | null>((resolve) => {
        const timer = setTimeout(() => {
          if (!pendingLivenessProbes.delete(requestId)) return;
          resolve(null); // host mudo = unverifiable, nunca morte
        }, LIVENESS_PROBE_TIMEOUT_MS);
        timer.unref?.();
        pendingLivenessProbes.set(requestId, { resolve, timer });
        try {
          transport.post({
            type: 'liveness-probe',
            requestId,
            sessionIds: [...sessionIds],
          });
        } catch {
          if (pendingLivenessProbes.delete(requestId)) {
            clearTimeout(timer);
            resolve(null);
          }
        }
      });
    },
  };

  function dispatchEvent(msg: HostEventMsg): void {
    if (msg.type === 'prepared-command') {
      const pending = pendingPreparations.get(msg.requestId); if (!pending) return;
      pendingPreparations.delete(msg.requestId); clearTimeout(pending.timer); pending.resolve(msg.command); return;
    }
    if (msg.type === 'native-heavy-job-base') {
      const pending = pendingJobBases.get(msg.requestId); if (!pending) return;
      clearTimeout(pending.timer); pendingJobBases.delete(msg.requestId); pending.resolve(msg.command); return;
    }
    if (msg.type === 'command-process-result') {
      const pending = pendingCommands.get(msg.requestId); if (!pending || pending.sessionId !== msg.sessionId) return;
      pendingCommands.delete(msg.requestId); clearTimeout(pending.timer);
      if (pending.claim && msg.claimId) {
        try { transport.post({ type: 'command-process-confirm', requestId: msg.requestId, sessionId: msg.sessionId, claimId: msg.claimId }); }
        catch { try { transport.post({ type: 'command-process-cancel', requestId: msg.requestId, sessionId: msg.sessionId }); } catch {} pending.resolve(null); return; }
      }
      pending.resolve(msg); return;
    }

    if (msg.type === 'termination-result') {
      const pending = pendingTerminations.get(msg.requestId);
      if (!pending || pending.sessionId !== msg.sessionId) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingTerminations.delete(msg.requestId);
      pending.resolve(msg.proof);
      return;
    }
    if (msg.type === 'footprint-report') {
      const pending = pendingFootprintProbes.get(msg.requestId);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingFootprintProbes.delete(msg.requestId);
      pending.resolve(msg.footprints);
      return;
    }
    if (msg.type === 'liveness-report') {
      const pending = pendingLivenessProbes.get(msg.requestId);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingLivenessProbes.delete(msg.requestId);
      pending.resolve(new Set(msg.live));
      return;
    }
    const h = handlers.get(msg.sessionId);
    if (!h) return;
    if (msg.type === 'data') {
      h.onData(msg.data);
      return;
    }
    handlers.delete(msg.sessionId);
    reservations.delete(msg.sessionId);
    h.onExit(msg.exitCode, msg.signal);
  }

  function handleHostDown(): void {
    for (const pending of pendingPreparations.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    pendingPreparations.clear();
    for (const pending of pendingJobBases.values()) { clearTimeout(pending.timer); pending.resolve(null); } pendingJobBases.clear();
    for (const pending of pendingCommands.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    pendingCommands.clear();

    // Probes pendentes: host morto = resposta nenhuma → unverifiable. As
    // sessões órfãs recebem onExit(-1) logo abaixo, pela via de host-down.
    const probes = [...pendingLivenessProbes.values()];
    pendingLivenessProbes.clear();
    for (const probe of probes) {
      if (probe.timer) clearTimeout(probe.timer);
      probe.resolve(null);
    }
    const pending = [...pendingTerminations.values()];
    pendingTerminations.clear();
    for (const operation of pending) {
      if (operation.timer) clearTimeout(operation.timer);
      operation.resolve({
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error:
          'O PTY host encerrou antes da prova física dos descendentes.',
      });
    }
    for (const pending of pendingSpawns.values()) void pending.cancel().catch(() => {});
    for (const [id, h] of handlers) {
      const reservation = reservations.get(id); if (reservation && pendingSpawns.has(reservation)) continue;
      handlers.delete(id); reservations.delete(id); h.onExit(-1, undefined);
    }
  }

  return { host, dispatchEvent, handleHostDown, sessionCount: () => handlers.size };
}
