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

/**
 * Reserva de RAM por tipo de comando pesado (otimização multi-pane, 06/10).
 * `tsc` medido em ~720 MB no Mac do operador; testes tipam na mesma faixa.
 * `install`/`build` usam o fallback do pool (2048 por default) — `npm ci` e
 * builds de bundle estouram com facilidade.
 */
export function heavyCommandReserveMB(kind: HeavyCommandKind, fallback = 2048): number {
  if (kind === 'typescript' || kind === 'tests') return 1024;
  return fallback;
}

/**
 * Vagas por projeto. A regra histórica é 1 (a worktree é local de execução,
 * nunca orçamento próprio de CPU/RAM). Com memória de sobra o pool abre a
 * 2ª vaga do MESMO projeto: dois `tsc`/suites em um Mac de 8+ núcleos não
 * brigam por CPU o suficiente para justificar a fila, e a fila era o que
 * parava a missão no meio (7h30 de validações em fila única, F-714). Memória
 * apertada volta a 1 — a proteção real é a reserva de RAM, não o número fixo.
 */
const PROJECT_SLOTS_ABUNDANT = 2;
const PROJECT_SLOTS_TIGHT = 1;
/** Sobra mínima além das reservas para considerar a 2ª vaga do projeto. */
const ABUNDANT_HEADROOM_MB = 1024;

/** Espera do worker de missão: a fila drena, o worker não pode falhar no meio. */
const MISSION_WAIT_MS = 900_000;
const DEFAULT_WAIT_MS = 300_000;

/** One or two physical heavy jobs per project (RAM-gated); RAM reservations span projects. */
export class HeavyCommandPermitPool {
  readonly #options: PermitPoolOptions;
  readonly #waiters: Waiter[] = [];
  readonly #active = new Map<string, { project: string; kind: HeavyCommandKind; reserveMB: number }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refresh: Promise<void> | undefined;
  #closed = false;

  constructor(options: PermitPoolOptions) { this.#options = options; }

  snapshot(): { active: number; waiting: number; reservedMB: number } {
    let reservedMB = 0;
    for (const entry of this.#active.values()) reservedMB += entry.reserveMB;
    return { active: this.#active.size, waiting: this.#waiters.length, reservedMB };
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
    // Missão espera a fila drenar (otimização multi-pane): o worker não pode
    // falhar o tool call em 5 min enquanto o validador anterior termina.
    const waitMs = request.missionId !== undefined
      ? (this.#options.waitMs ?? MISSION_WAIT_MS)
      : (this.#options.waitMs ?? DEFAULT_WAIT_MS);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { request, project, resolve, reject,
        deadline: Date.now() + waitMs,
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

  #hasRam(reserveMB: number): boolean {
    let memory: SystemMemorySample | null;
    try { memory = this.#options.memory(); } catch { memory = null; }
    if (memory?.freeMB === null || memory === null || !Number.isFinite(memory.freeMB)) {
      // Missing telemetry is explicit: conservative machine-wide serialization,
      // not invented free RAM and not a permanent inability to run one job.
      return this.#active.size === 0;
    }
    const limits = this.#options.limits();
    if (limits.maxSwapUsedMB > 0 && memory.swapUsedMB !== null && memory.swapUsedMB > limits.maxSwapUsedMB) return false;
    return memory.freeMB >= limits.minFreeMB + this.snapshot().reservedMB + reserveMB;
  }

  /** Vagas do projeto: 2 com memória de sobra, 1 sob pressão (ver PROJECT_SLOTS_*). */
  #projectSlots(): number {
    let memory: SystemMemorySample | null;
    try { memory = this.#options.memory(); } catch { memory = null; }
    if (memory?.freeMB === null || memory === null || !Number.isFinite(memory.freeMB)) {
      return PROJECT_SLOTS_TIGHT;
    }
    const limits = this.#options.limits();
    if (limits.maxSwapUsedMB > 0 && memory.swapUsedMB !== null && memory.swapUsedMB > limits.maxSwapUsedMB) {
      return PROJECT_SLOTS_TIGHT;
    }
    const reserve = this.#options.reserveMB ?? 2048;
    return memory.freeMB >= limits.minFreeMB + this.snapshot().reservedMB + reserve + ABUNDANT_HEADROOM_MB
      ? PROJECT_SLOTS_ABUNDANT
      : PROJECT_SLOTS_TIGHT;
  }

  #pump(): void {
    if (this.#closed) return;
    const projectSlots = this.#projectSlots();
    const perProjectActive = new Map<string, number>();
    for (const entry of this.#active.values()) {
      perProjectActive.set(entry.project, (perProjectActive.get(entry.project) ?? 0) + 1);
    }
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
      const activeInProject = perProjectActive.get(waiter.project) ?? 0;
      const reserveMB = heavyCommandReserveMB(waiter.request.kind, this.#options.reserveMB ?? 2048);
      if (activeInProject >= projectSlots || this.#active.size >= 32 || !this.#hasRam(reserveMB)) {
        blockedProjects.add(waiter.project); continue;
      }
      this.#remove(waiter);
      const id = `heavy-${randomUUID()}`;
      this.#active.set(id, { project: waiter.project, kind: waiter.request.kind, reserveMB });
      perProjectActive.set(waiter.project, activeInProject + 1);
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
