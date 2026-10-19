import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { ProjectExecutionScope } from '../../shared/types';
import { getMemoryAfterAgentReservations, readPaneAdmissionLimits, refreshSystemMemorySample, registerHeavyCommandMemoryReservation, type SystemMemorySample } from './pane-admission';

export type HeavyCommandKind = 'typescript' | 'tests' | 'build' | 'install';
export type HeavyCommandBlock = 'exclusive' | 'writer-ahead' | 'machine' | 'ram' | 'pressure' | 'swap';
export interface HeavyCommandOccupant {
  readonly sessionId?: string;
  readonly paneId?: string;
  readonly label?: string;
  readonly kind: HeavyCommandKind;
  readonly ageMs: number;
}
export interface HeavyCommandRequest {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly paneId?: string;
  /** Short command label. Anything outside `[\w .:/_-]{1,80}` is dropped. */
  readonly label?: string;
  readonly kind: HeavyCommandKind;
  /** The pid that asked for admission. Feeds the ghost-lease expiry below. */
  readonly executorPid?: number;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  /** When finite, an attached waiter parks and rejects with `heavy_command_queued`. */
  readonly progressAfterMs?: number;
  /** Reattach a parked waiter. Unknown tickets enqueue as a new wait. */
  readonly queueTicket?: string;
}
/** release is Main-only: callers must first prove physical exit or no spawn. */
export interface HeavyCommandPermit { readonly id: string; release(): void }
/** F-1229: why a waiter is still queued — attached to `heavy_command_wait_timeout` or `heavy_command_queued`. */
export interface HeavyCommandQueueWait {
  readonly waitedMs: number;
  readonly root: string;
  /** Jobs of the same execution root: running now / still waiting besides this one. */
  readonly running: number;
  readonly waiting: number;
  readonly machineActive: number;
  /** Configured machine cap, before memory pressure shrinks it. */
  readonly maxActive: number;
  /** Cap actually applied. Lower than maxActive only while pressure is warn (2) or critical (4). */
  readonly effectiveMaxActive?: number;
  /** F-1434: the RAM budget at give-up time; freeMB null = no telemetry. */
  readonly memory?: { readonly freeMB: number | null; readonly neededMB: number; readonly swapBound: boolean };
  readonly occupants: readonly HeavyCommandOccupant[];
  readonly blockedBy: HeavyCommandBlock;
}
interface Gap {
  readonly promise: Promise<HeavyCommandPermit>;
  readonly resolve: (permit: HeavyCommandPermit) => void;
  readonly reject: (error: Error) => void;
}
interface Waiter {
  request: HeavyCommandRequest;
  readonly lane: string;
  readonly since: number;
  readonly deadline: number;
  resolve: (permit: HeavyCommandPermit) => void;
  reject: (error: Error) => void;
  readonly aborted: () => void;
  ticket?: string;
  attached: boolean;
  progressAt: number;
  parkedAt?: number;
  parked?: Gap;
}
interface ActiveJob {
  readonly lane: string;
  readonly kind: HeavyCommandKind;
  readonly sessionId?: string;
  readonly paneId?: string;
  readonly label?: string;
  readonly executorPid?: number;
  readonly startedAt: number;
  /** First observation of a dead executor/session; reset the moment either revives. */
  deadSince: number | null;
}
interface PermitPoolOptions {
  memory(): SystemMemorySample | null;
  limits(): { minFreeMB: number; maxSwapUsedMB: number };
  refreshMemory(): Promise<void>;
  readonly reserveMB?: number;
  readonly maxWaiters?: number;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly maxActive?: number;
  /** Drop a parked waiter that nobody reattached. Unset: parked waiters stay until retry or close. */
  readonly parkMs?: number;
  /** Test seam. Production leaves this unset; the native HTTP request opts in per call. */
  readonly progressAfterMs?: number;
  /** Cached dispatch level from kern.memorystatus_vm_pressure_level, or null. */
  pressure?(): number | null;
  /** True while the admitted executor pid exists. ESRCH-style check; errors read as alive. */
  readonly executorLive?: (pid: number) => boolean;
  /** True while the owning session still exists (pane open). */
  readonly sessionLive?: (sessionId: string) => boolean;
  /**
   * Ghost-lease TTL: how long an exclusive build/install stays held after BOTH
   * the executor pid and the owner session probe say gone. The native watcher
   * releases a slot only through its own cohort proof; a caller that dies while
   * its processes were re-parented to a daemon never delivers that proof, and
   * without this TTL the lane stays locked forever. Default 60 s. Without the
   * probes the pool never expires a lease on its own.
   */
  readonly staleExclusiveMs?: number;
}
const LABEL_PATTERN = /^[\w .:/_-]{1,80}$/;
/** Drop a label that could carry a secret or a control character. */
export function heavyCommandLabel(raw: string | undefined): string | undefined {
  return raw && LABEL_PATTERN.test(raw) ? raw : undefined;
}
/** Build and install share outputs. Typecheck and tests only read them. */
export function heavyCommandKindIsExclusive(kind: HeavyCommandKind): boolean {
  return kind === 'build' || kind === 'install';
}
/**
 * A writer needs the root to itself. A reader waits for a running writer or
 * for a writer already ahead of it. Readers do not block each other here.
 */
export function heavyLaneBlocked(input: {
  readonly kind: HeavyCommandKind;
  readonly occupants: readonly { readonly kind: HeavyCommandKind }[];
  readonly earlierExclusive: boolean;
}): boolean {
  if (heavyCommandKindIsExclusive(input.kind)) return input.occupants.length > 0;
  if (input.occupants.some((occupant) => heavyCommandKindIsExclusive(occupant.kind))) return true;
  return input.earlierExclusive;
}
const error = (code: string) => new Error(`heavy_command_${code}`);

// Shipped HTTP/curl/file clients expire at 360 s. Return a bounded, retryable
// admission failure first; extending this requires a matching transport and
// cancellation contract. Mission and loose-helper requests share this limit.
const DEFAULT_WAIT_MS = 300_000;

/**
 * F-983: the lane is one execution root (checkout or worktree), never one per
 * project. Parallel writers each own a worktree. Build and install stay
 * exclusive on a root because they share outputs and caches. Typecheck and
 * tests of that root run together, up to the machine RAM and CPU bounds.
 */
const machineActiveLimit = (): number => {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Hang prevention, not rationing: past half the cores, parallel test
  // runners starve the UI and the PTYs of the agents themselves.
  return Math.max(2, Math.floor(cpus / 2));
};

/**
 * `sysctl kern.memorystatus_vm_pressure_level` returns the dispatch level:
 * 1 normal, 2 warn, 4 critical. xnu doc/vm/memorystatus_notify.md describes
 * the internal enum (0 normal, 1 warning, 2 urgent, 3 critical, 4 jetsam),
 * which is not the value this sysctl exposes.
 * Fail-open: null or any other value keeps the configured cap.
 * Never stops a job already running.
 */
export function heavyCommandEffectiveCap(configured: number, level: number | null): number {
  if (level === 2) return Math.min(configured, 2);
  if (level === 4) return Math.min(configured, 1);
  return configured;
}

const PRESSURE_INTERVAL_MS = 3_000;

export function parseHeavyCommandPressureOutput(raw: string): number | null {
  const level = Number(String(raw).trim());
  return Number.isInteger(level) ? level : null;
}

export interface HeavyCommandPressureProbe { (callback: (level: number | null) => void): void }

/** Pump reads the last sample. A refresh is async and at most one is in flight. */
export function createHeavyCommandPressureCache(options?: {
  now?: () => number;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  probe?: HeavyCommandPressureProbe;
}): () => number | null {
  const now = options?.now ?? Date.now;
  const intervalMs = options?.intervalMs ?? PRESSURE_INTERVAL_MS;
  const platform = options?.platform ?? process.platform;
  const probe = options?.probe ?? defaultHeavyCommandPressureProbe;
  let level: number | null = null;
  let startedAt = Number.NEGATIVE_INFINITY;
  let inflight = false;
  return () => {
    if (platform !== 'darwin') return null;
    const current = now();
    if (!inflight && current - startedAt >= intervalMs) {
      inflight = true;
      startedAt = current;
      try { probe((next) => { inflight = false; level = next; }); }
      catch { inflight = false; level = null; }
    }
    return level;
  };
}

function defaultHeavyCommandPressureProbe(callback: (level: number | null) => void): void {
  execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'],
    { timeout: 1000, encoding: 'utf8' },
    (error, stdout) => { callback(error ? null : parseHeavyCommandPressureOutput(String(stdout ?? ''))); });
}

export const readHeavyCommandMemoryPressure = createHeavyCommandPressureCache();

export class HeavyCommandPermitPool {
  readonly #options: PermitPoolOptions;
  readonly #waiters: Waiter[] = [];
  readonly #active = new Map<string, ActiveJob>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refresh: Promise<void> | undefined;
  #closed = false;

  constructor(options: PermitPoolOptions) { this.#options = options; }

  snapshot(): { active: number; waiting: number; reservedMB: number } {
    return { active: this.#active.size, waiting: this.#waiters.length,
      reservedMB: this.#active.size * (this.#options.reserveMB ?? 2048) };
  }

  acquire(request: HeavyCommandRequest): Promise<HeavyCommandPermit> {
    // Callers are Main-owned agent execution paths. A loose helper has no
    // mission, and role=user is also used by CLI agents: neither means a
    // command came from a human shell outside Nexus.
    if (this.#closed) return Promise.reject(error('closed'));
    if (request.signal?.aborted) return Promise.reject(error('aborted'));
    if (request.queueTicket) {
      const existing = this.#waiters.find((waiter) => waiter.ticket === request.queueTicket);
      if (existing) return this.#reattach(existing, request);
    }
    if (this.#waiters.length >= (this.#options.maxWaiters ?? 128)) return Promise.reject(error('queue_full'));
    // RAM/CPU are machine-wide. The lane only keeps build/install exclusive.
    const lane = JSON.stringify([request.scope.installationId, request.scope.projectId, request.scope.rootRealPath]);
    return new Promise((resolve, reject) => {
      const since = Date.now();
      const waiter: Waiter = { request, lane, resolve, reject, since, attached: true,
        deadline: since + (this.#options.waitMs ?? DEFAULT_WAIT_MS),
        progressAt: this.#progressAt(request, since),
        aborted: () => { this.#remove(waiter); waiter.reject(error('aborted')); this.#pump(); },
      };
      this.#waiters.push(waiter);
      request.signal?.addEventListener('abort', waiter.aborted, { once: true });
      this.#pump();
    });
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const waiter of [...this.#waiters]) { this.#remove(waiter); waiter.reject(error('closed')); }
    // Active reservations survive closing/cancellation until their owners
    // supply physical exit proof. Teardown is not evidence that work stopped.
  }

  #reattach(waiter: Waiter, request: HeavyCommandRequest): Promise<HeavyCommandPermit> {
    waiter.request.signal?.removeEventListener('abort', waiter.aborted);
    const gap = waiter.parked;
    waiter.parked = undefined;
    gap?.reject(error('reattached'));
    waiter.request = request;
    waiter.attached = true;
    waiter.parkedAt = undefined;
    waiter.progressAt = this.#progressAt(request, Date.now());
    const promise = new Promise<HeavyCommandPermit>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    request.signal?.addEventListener('abort', waiter.aborted, { once: true });
    this.#pump();
    return promise;
  }

  #progressAt(request: HeavyCommandRequest, now: number): number {
    const after = request.progressAfterMs ?? this.#options.progressAfterMs;
    return typeof after === 'number' && Number.isFinite(after) ? now + after : Number.POSITIVE_INFINITY;
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
    waiter.request.signal?.removeEventListener('abort', waiter.aborted);
    waiter.attached = false;
  }

  #pressureLevel(): number | null {
    const read = this.#options.pressure;
    if (!read) return null;
    try {
      const level = read();
      return typeof level === 'number' && Number.isInteger(level) ? level : null;
    } catch { return null; }
  }

  #occupants(lane: string): HeavyCommandOccupant[] {
    const now = Date.now();
    return [...this.#active.values()].filter((entry) => entry.lane === lane).map((entry) => ({
      sessionId: entry.sessionId, paneId: entry.paneId, label: entry.label, kind: entry.kind,
      ageMs: Math.max(0, now - entry.startedAt),
    }));
  }

  /**
   * Second release path for exclusive leases whose owner can no longer prove
   * physical exit: the executor pid is gone (ESRCH) or the owning session
   * closed while the watcher's cohort proof is stuck on daemon-inherited
   * processes. A probe that errors or flaps back to alive resets the clock —
   * a live job is never expired.
   */
  #expireStaleExclusive(): void {
    const ttl = this.#options.staleExclusiveMs;
    if (ttl === undefined || ttl <= 0 || this.#active.size === 0) return;
    const executorLive = this.#options.executorLive;
    const sessionLive = this.#options.sessionLive;
    const now = Date.now();
    for (const [id, job] of this.#active) {
      if (!heavyCommandKindIsExclusive(job.kind)) continue;
      let gone = false;
      if (typeof job.executorPid === 'number' && executorLive) {
        try { gone = !executorLive(job.executorPid); } catch { gone = false; }
      }
      if (!gone && job.sessionId && sessionLive) {
        try { gone = !sessionLive(job.sessionId); } catch { gone = false; }
      }
      if (!gone) { job.deadSince = null; continue; }
      job.deadSince ??= now;
      if (now - job.deadSince >= ttl) this.#active.delete(id);
    }
  }

  #blockedBy(waiter: Waiter, maxActive: number, effectiveMaxActive: number): HeavyCommandBlock {
    const occupants = this.#occupants(waiter.lane);
    const index = this.#waiters.indexOf(waiter);
    const earlierExclusive = this.#waiters.some((other, otherIndex) => other.lane === waiter.lane && otherIndex < index
      && heavyCommandKindIsExclusive(other.request.kind));
    if (heavyLaneBlocked({ kind: waiter.request.kind, occupants, earlierExclusive })) {
      return heavyCommandKindIsExclusive(waiter.request.kind) || occupants.some((occupant) => heavyCommandKindIsExclusive(occupant.kind))
        ? 'exclusive' : 'writer-ahead';
    }
    if (this.#active.size >= effectiveMaxActive) return effectiveMaxActive < maxActive ? 'pressure' : 'machine';
    const budget = this.#memoryBudget();
    if (budget.swapBound) return 'swap';
    if (budget.freeMB === null || budget.freeMB < budget.neededMB) return 'ram';
    return 'machine';
  }

  #queueWait(waiter: Waiter, blockedBy: HeavyCommandBlock, maxActive: number, effectiveMaxActive: number): HeavyCommandQueueWait {
    return { waitedMs: Date.now() - waiter.since, root: waiter.request.scope.rootRealPath,
      running: [...this.#active.values()].filter(entry => entry.lane === waiter.lane).length,
      waiting: this.#waiters.filter(other => other !== waiter && other.lane === waiter.lane).length,
      machineActive: this.#active.size, maxActive, effectiveMaxActive, memory: this.#memoryBudget(),
      occupants: this.#occupants(waiter.lane), blockedBy };
  }

  #memoryBudget(): { freeMB: number | null; neededMB: number; swapBound: boolean } {
    let memory: SystemMemorySample | null;
    try { memory = this.#options.memory(); } catch { memory = null; }
    const limits = this.#options.limits();
    const neededMB = limits.minFreeMB + this.snapshot().reservedMB + (this.#options.reserveMB ?? 2048);
    const freeMB = memory && memory.freeMB !== null && Number.isFinite(memory.freeMB) ? memory.freeMB : null;
    const swapBound = Boolean(memory && limits.maxSwapUsedMB > 0 && memory.swapUsedMB !== null && memory.swapUsedMB > limits.maxSwapUsedMB);
    return { freeMB, neededMB, swapBound };
  }

  #hasRam(): boolean {
    const budget = this.#memoryBudget();
    // Missing telemetry is explicit: conservative machine-wide serialization,
    // not invented free RAM and not a permanent inability to run one job.
    if (budget.freeMB === null) return this.#active.size === 0;
    if (budget.swapBound) return false;
    return budget.freeMB >= budget.neededMB;
  }

  #current(waiter: Waiter): boolean {
    try { return !waiter.request.signal?.aborted && (waiter.request.isCurrent?.() ?? true); }
    catch { return false; }
  }

  #park(waiter: Waiter, blockedBy: HeavyCommandBlock, maxActive: number, effective: number): void {
    waiter.request.signal?.removeEventListener('abort', waiter.aborted);
    waiter.attached = false;
    waiter.parkedAt = Date.now();
    waiter.ticket ??= `hq-${randomUUID()}`;
    let resolve!: Gap['resolve'];
    let reject!: Gap['reject'];
    const promise = new Promise<HeavyCommandPermit>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    const abandon = waiter.reject;
    waiter.resolve = resolve;
    waiter.reject = reject;
    waiter.parked = { promise, resolve, reject };
    abandon(Object.assign(error('queued'), { ticket: waiter.ticket, queue: this.#queueWait(waiter, blockedBy, maxActive, effective) }));
  }

  #pump(): void {
    if (this.#closed) return;
    // Runs only while someone waits (the timer below): expiry exists to unblock
    // a queued lane, not to sweep idle state.
    this.#expireStaleExclusive();
    const maxActive = this.#options.maxActive ?? machineActiveLimit();
    const effective = heavyCommandEffectiveCap(maxActive, this.#pressureLevel());
    const writerAhead = new Set<string>();
    for (const waiter of [...this.#waiters]) {
      if (!this.#waiters.includes(waiter)) continue;
      if (!waiter.attached) {
        if (!this.#current(waiter)) { this.#remove(waiter); waiter.reject(error('authority_revoked')); continue; }
        const parkMs = this.#options.parkMs;
        if (parkMs !== undefined && waiter.parkedAt !== undefined && Date.now() - waiter.parkedAt >= parkMs) {
          this.#remove(waiter); waiter.reject(error('aborted')); continue;
        }
        if (heavyCommandKindIsExclusive(waiter.request.kind)) writerAhead.add(waiter.lane);
        continue;
      }
      const current = this.#current(waiter);
      if (!current || Date.now() >= waiter.deadline) {
        const blockedBy = this.#blockedBy(waiter, maxActive, effective);
        const failure = current ? Object.assign(error('wait_timeout'), { queue: this.#queueWait(waiter, blockedBy, maxActive, effective) }) : error('authority_revoked');
        this.#remove(waiter); waiter.reject(failure); continue;
      }
      const occupants = this.#occupants(waiter.lane);
      const laneBlocked = heavyLaneBlocked({ kind: waiter.request.kind, occupants, earlierExclusive: writerAhead.has(waiter.lane) });
      const machineFull = this.#active.size >= effective;
      const ramOk = !machineFull && !laneBlocked && this.#hasRam();
      if (laneBlocked || machineFull || !ramOk) {
        if (heavyCommandKindIsExclusive(waiter.request.kind)) writerAhead.add(waiter.lane);
        const blockedBy = this.#blockedBy(waiter, maxActive, effective);
        if (Date.now() >= waiter.progressAt) this.#park(waiter, blockedBy, maxActive, effective);
        continue;
      }
      this.#remove(waiter);
      const id = `heavy-${randomUUID()}`;
      const label = heavyCommandLabel(waiter.request.label);
      this.#active.set(id, { lane: waiter.lane, kind: waiter.request.kind, sessionId: waiter.request.sessionId,
        paneId: waiter.request.paneId, label, executorPid: waiter.request.executorPid, startedAt: Date.now(), deadSince: null });
      // The synchronous reservation precedes resolving the caller's promise.
      // Two lanes cannot both spend the same cached free RAM.
      waiter.resolve(Object.freeze({ id, release: () => {
        if (this.#active.delete(id)) this.#pump();
      } }));
    }
    if (this.#waiters.length === 0) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }
    if (!this.#refresh) {
      this.#refresh = Promise.resolve().then(() => this.#options.refreshMemory()).catch(() => undefined)
        .finally(() => { this.#refresh = undefined; });
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#timer = undefined; this.#pump(); }, this.#options.pollMs ?? 1000);
      this.#timer.unref?.();
    }
  }
}

interface HeavyCommandLivenessProbe {
  /** kill(pid, 0)-style check; true keeps the lease (ESRCH gone, EPERM alive). */
  executorLive(pid: number): boolean;
  /** True while the owning PTY session still exists. */
  sessionLive(sessionId: string): boolean;
}
let livenessProbe: HeavyCommandLivenessProbe | null = null;
/**
 * Wired once by native-heavy-command at boot (it owns the pid/session checks;
 * importing them here would cycle). Until then the pool never expires a lease
 * on its own — the pre-existing behavior.
 */
export function setHeavyCommandPermitLiveness(probe: HeavyCommandLivenessProbe): void { livenessProbe = probe; }

const permits = new HeavyCommandPermitPool({ memory: getMemoryAfterAgentReservations, limits: readPaneAdmissionLimits,
  refreshMemory: refreshSystemMemorySample, pressure: readHeavyCommandMemoryPressure,
  waitMs: Number.POSITIVE_INFINITY, parkMs: 45_000, staleExclusiveMs: 60_000,
  executorLive: (pid) => { try { return livenessProbe?.executorLive(pid) ?? true; } catch { return true; } },
  sessionLive: (sessionId) => { try { return livenessProbe?.sessionLive(sessionId) ?? true; } catch { return true; } } });
registerHeavyCommandMemoryReservation(() => permits.snapshot().reservedMB);
export function acquireHeavyCommandPermit(request: HeavyCommandRequest): Promise<HeavyCommandPermit> { return permits.acquire(request); }
export function heavyCommandPermitSnapshot(): ReturnType<HeavyCommandPermitPool['snapshot']> { return permits.snapshot(); }
export function closeHeavyCommandPermits(): void { permits.close(); }
