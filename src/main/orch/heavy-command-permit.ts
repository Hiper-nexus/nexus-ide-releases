import { randomUUID } from 'node:crypto';
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
interface Waiter {
  readonly request: HeavyCommandRequest;
  readonly project: string;
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
}
const error = (code: string) => new Error(`heavy_command_${code}`);

// Shipped HTTP/curl/file clients expire at 360 s. Return a bounded, retryable
// admission failure first; extending this requires a matching transport and
// cancellation contract. Mission and loose-helper requests share this limit.
const DEFAULT_WAIT_MS = 300_000;

/** One physical heavy job per project; machine RAM reservations span projects. */
export class HeavyCommandPermitPool {
  readonly #options: PermitPoolOptions;
  readonly #waiters: Waiter[] = [];
  readonly #active = new Map<string, { project: string; kind: HeavyCommandKind }>();
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
    // A worktree is an execution location, never a separate CPU/RAM budget.
    const project = JSON.stringify([request.scope.installationId, request.scope.projectId]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { request, project, resolve, reject,
        deadline: Date.now() + (this.#options.waitMs ?? DEFAULT_WAIT_MS),
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

  #hasRam(): boolean {
    let memory: SystemMemorySample | null;
    try { memory = this.#options.memory(); } catch { memory = null; }
    if (memory?.freeMB === null || memory === null || !Number.isFinite(memory.freeMB)) {
      // Missing telemetry is explicit: conservative machine-wide serialization,
      // not invented free RAM and not a permanent inability to run one job.
      return this.#active.size === 0;
    }
    const limits = this.#options.limits();
    if (limits.maxSwapUsedMB > 0 && memory.swapUsedMB !== null && memory.swapUsedMB > limits.maxSwapUsedMB) return false;
    return memory.freeMB >= limits.minFreeMB + this.snapshot().reservedMB + (this.#options.reserveMB ?? 2048);
  }

  #pump(): void {
    if (this.#closed) return;
    const blockedProjects = new Set<string>();
    for (const waiter of [...this.#waiters]) {
      let current = false;
      try { current = !waiter.request.signal?.aborted && (waiter.request.isCurrent?.() ?? true); } catch { /* revoked */ }
      if (!this.#waiters.includes(waiter)) continue;
      current &&= !waiter.request.signal?.aborted;
      if (!current || Date.now() >= waiter.deadline) {
        this.#remove(waiter); waiter.reject(error(current ? 'wait_timeout' : 'authority_revoked')); continue;
      }
      if (blockedProjects.has(waiter.project)) continue;
      const activeProject = [...this.#active.values()].some(entry => entry.project === waiter.project);
      if (activeProject || this.#active.size >= 32 || !this.#hasRam()) { blockedProjects.add(waiter.project); continue; }
      this.#remove(waiter);
      const id = `heavy-${randomUUID()}`;
      this.#active.set(id, { project: waiter.project, kind: waiter.request.kind });
      // The synchronous reservation precedes resolving the caller's promise.
      // Two project spawns cannot both spend the same cached free RAM.
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
  refreshMemory: refreshSystemMemorySample });
registerHeavyCommandMemoryReservation(() => permits.snapshot().reservedMB);
export function acquireHeavyCommandPermit(request: HeavyCommandRequest): Promise<HeavyCommandPermit> { return permits.acquire(request); }
export function heavyCommandPermitSnapshot(): ReturnType<HeavyCommandPermitPool['snapshot']> { return permits.snapshot(); }
export function closeHeavyCommandPermits(): void { permits.close(); }
