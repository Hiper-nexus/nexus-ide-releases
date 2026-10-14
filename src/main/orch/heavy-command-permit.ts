import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { ProjectExecutionScope } from '../../shared/types';
import { getMemoryAfterAgentReservations, readPaneAdmissionLimits, refreshSystemMemorySample, registerHeavyCommandMemoryReservation, type SystemMemorySample } from './pane-admission';

export type HeavyCommandKind = 'typescript' | 'tests' | 'build' | 'install';
export interface HeavyCommandRequest {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly kind: HeavyCommandKind;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}
/** release is Main-only: callers must first prove physical exit or no spawn. */
export interface HeavyCommandPermit { readonly id: string; release(): void }
/** F-1229: why a waiter gave up — attached to `heavy_command_wait_timeout`. */
export interface HeavyCommandQueueWait {
  readonly waitedMs: number;
  readonly root: string;
  /** Jobs of the same execution root: running now / still waiting besides this one. */
  readonly running: number;
  readonly waiting: number;
  readonly machineActive: number;
  /** Configured machine cap, before memory pressure shrinks it. */
  readonly maxActive: number;
  /** Cap actually applied. Lower than maxActive only while pressure is warn or critical. */
  readonly effectiveMaxActive?: number;
  /** F-1434: the RAM budget at give-up time; freeMB null = no telemetry. */
  readonly memory?: { readonly freeMB: number | null; readonly neededMB: number; readonly swapBound: boolean };
}
interface Waiter {
  readonly request: HeavyCommandRequest;
  readonly lane: string;
  readonly since: number;
  readonly deadline: number;
  readonly resolve: (permit: HeavyCommandPermit) => void;
  readonly reject: (error: Error) => void;
  readonly aborted: () => void;
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
  /** Darwin kern.memorystatus_vm_pressure_level, or null when it cannot be read. */
  pressure?(): number | null;
}
const error = (code: string) => new Error(`heavy_command_${code}`);

// Shipped HTTP/curl/file clients expire at 360 s. Return a bounded, retryable
// admission failure first; extending this requires a matching transport and
// cancellation contract. Mission and loose-helper requests share this limit.
const DEFAULT_WAIT_MS = 300_000;

/**
 * F-983: one physical heavy job per execution root (checkout or worktree),
 * never one per project. Parallel writers each own a worktree and must be able
 * to test at the same time; the machine RAM reservation and the CPU bound
 * below are what keep that safe. Two jobs in the SAME root still serialize:
 * they share build outputs and caches.
 */
const machineActiveLimit = (): number => {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Hang prevention, not rationing: past half the cores, parallel test
  // runners starve the UI and the PTYs of the agents themselves.
  return Math.max(2, Math.floor(cpus / 2));
};

/**
 * xnu doc/vm/memorystatus_notify.md: 0 normal, 1 warning, 2 urgent
 * (same band as warning), 3 critical, 4 jetsam. Older kVMPressure bitfield
 * values are a different API and do not match this sysctl.
 * Fail-open: no reading keeps the configured cap. Never stops a job already running.
 */
export function heavyCommandEffectiveCap(configured: number, level: number | null): number {
  if (level === 1 || level === 2) return Math.min(configured, 2);
  if (level === 3 || level === 4) return Math.min(configured, 1);
  return configured;
}

export function readHeavyCommandMemoryPressure(): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const level = Number(raw);
    return Number.isInteger(level) && level >= 0 && level <= 4 ? level : null;
  } catch { return null; }
}

export class HeavyCommandPermitPool {
  readonly #options: PermitPoolOptions;
  readonly #waiters: Waiter[] = [];
  readonly #active = new Map<string, { lane: string; kind: HeavyCommandKind }>();
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
    if (this.#waiters.length >= (this.#options.maxWaiters ?? 128)) return Promise.reject(error('queue_full'));
    // RAM/CPU are machine-wide budgets; the lane only serializes jobs that
    // share one physical checkout (same build outputs and caches).
    const lane = JSON.stringify([request.scope.installationId, request.scope.projectId, request.scope.rootRealPath]);
    return new Promise((resolve, reject) => {
      const since = Date.now();
      const waiter: Waiter = { request, lane, resolve, reject, since,
        deadline: since + (this.#options.waitMs ?? DEFAULT_WAIT_MS),
        aborted: () => { this.#remove(waiter); reject(error('aborted')); this.#pump(); },
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

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
    waiter.request.signal?.removeEventListener('abort', waiter.aborted);
  }

  #pressureLevel(): number | null {
    const read = this.#options.pressure;
    if (!read) return null;
    try {
      const level = read();
      return typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 4 ? level : null;
    } catch { return null; }
  }

  #queueWait(waiter: Waiter, maxActive: number, effectiveMaxActive: number): HeavyCommandQueueWait {
    return { waitedMs: Date.now() - waiter.since, root: waiter.request.scope.rootRealPath,
      running: [...this.#active.values()].filter(entry => entry.lane === waiter.lane).length,
      waiting: this.#waiters.filter(other => other !== waiter && other.lane === waiter.lane).length,
      machineActive: this.#active.size, maxActive, effectiveMaxActive, memory: this.#memoryBudget() };
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

  #pump(): void {
    if (this.#closed) return;
    const blockedLanes = new Set<string>();
    const maxActive = this.#options.maxActive ?? machineActiveLimit();
    const effective = heavyCommandEffectiveCap(maxActive, this.#pressureLevel());
    for (const waiter of [...this.#waiters]) {
      let current = false;
      try { current = !waiter.request.signal?.aborted && (waiter.request.isCurrent?.() ?? true); } catch { /* revoked */ }
      if (!this.#waiters.includes(waiter)) continue;
      current &&= !waiter.request.signal?.aborted;
      if (!current || Date.now() >= waiter.deadline) {
        const failure = current ? Object.assign(error('wait_timeout'), { queue: this.#queueWait(waiter, maxActive, effective) }) : error('authority_revoked');
        this.#remove(waiter); waiter.reject(failure); continue;
      }
      if (blockedLanes.has(waiter.lane)) continue;
      const activeLane = [...this.#active.values()].some(entry => entry.lane === waiter.lane);
      if (activeLane || this.#active.size >= effective || !this.#hasRam()) { blockedLanes.add(waiter.lane); continue; }
      this.#remove(waiter);
      const id = `heavy-${randomUUID()}`;
      this.#active.set(id, { lane: waiter.lane, kind: waiter.request.kind });
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

const permits = new HeavyCommandPermitPool({ memory: getMemoryAfterAgentReservations, limits: readPaneAdmissionLimits,
  refreshMemory: refreshSystemMemorySample, pressure: readHeavyCommandMemoryPressure });
registerHeavyCommandMemoryReservation(() => permits.snapshot().reservedMB);
export function acquireHeavyCommandPermit(request: HeavyCommandRequest): Promise<HeavyCommandPermit> { return permits.acquire(request); }
export function heavyCommandPermitSnapshot(): ReturnType<HeavyCommandPermitPool['snapshot']> { return permits.snapshot(); }
export function closeHeavyCommandPermits(): void { permits.close(); }
