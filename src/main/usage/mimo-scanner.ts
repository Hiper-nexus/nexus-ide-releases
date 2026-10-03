import type { ProjectExecutionScope } from '../../shared/types';
import type { UsageRecord } from './usage-store';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { MimoWorkerReader, mimoValidationReader } from './mimo-worker-reader';
import { MIMO_SCAN_ROWS, type MimoRuntimeInput, type MimoScanCursor } from './mimo-worker-protocol';

export interface MimoSessionBinding {
  readonly ptySessionId: string;
  readonly paneId: string;
  readonly accountId?: string;
  /** Private native credential identity; never projected into usage or renderer DTOs. */
  readonly nativeOwnerKey?: string;
  readonly missionId?: string;
  readonly scope: ProjectExecutionScope;
  readonly cwd: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly providerSessionId: string;
}
export type MimoRuntime = Omit<MimoSessionBinding, 'providerSessionId'>;
const POLL_MS = 1_000;
const MAX_SEEN_MESSAGES = 8_192;
let scannerSequence = 0;
function runtimeInput(runtime: MimoRuntime): MimoRuntimeInput {
  return { checkoutId: runtime.scope.checkoutId, cwd: runtime.cwd,
    stateRoot: runtime.stateRoot, databasePath: runtime.databasePath };
}

/** Native validation runs in the dedicated readonly worker, never Main. */
export async function validateMimoRootSession(runtime: MimoRuntime, id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) return false;
  const reply = await mimoValidationReader().read({ kind: 'validate', runtime: runtimeInput(runtime), rootId: id });
  return reply?.valid === true;
}
interface ScanState {
  binding: MimoSessionBinding;
  cursor: MimoScanCursor;
  highWatermark: number;
  seen: Map<string, string>;
}

/** Main keeps attribution/cursors; native IO, SQL and private row parsing stay in the worker. */
export class MimoUsageScanner {
  readonly #states = new Map<string, ScanState>();
  readonly #retired: ScanState[] = [];
  readonly #reader = new MimoWorkerReader();
  readonly #taskId = `mimo-usage:${++scannerSequence}`;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #flight: Promise<void> | null = null;
  #stopFlight: Promise<void> | null = null;
  #next = 0;
  constructor(readonly onEvent: (binding: MimoSessionBinding, event: UsageRecord) => void) {}

  bind(binding: MimoSessionBinding): void {
    if (this.#stopped) return;
    const previous = this.#states.get(binding.ptySessionId);
    if (previous && JSON.stringify(previous.binding) === JSON.stringify(binding)) return;
    if (previous) this.#retired.push(previous);
    this.#states.set(binding.ptySessionId, { binding: Object.freeze({ ...binding, scope: Object.freeze({ ...binding.scope }) }),
      cursor: { at: 0, id: '' }, highWatermark: 0, seen: new Map() });
    if (previous) void this.scan();
  }
  start(): void {
    if (this.#stopped) return;
    if (!this.#timer) this.#timer = setInterval(() => { void this.scan(); }, POLL_MS);
    this.#timer.unref?.();
  }
  remove(ptySessionId: string): void {
    if (this.#stopped) return;
    const state = this.#states.get(ptySessionId);
    if (state) this.#retired.push(state);
    this.#states.delete(ptySessionId);
    void this.scan();
  }
  scan(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#flight) return this.#flight;
    this.#flight = runPeriodicTask(this.#taskId, async ctx => {
      const active = [...this.#states.values()];
      const states = this.#retired.splice(0, 4);
      const count = Math.min(4 - states.length, active.length);
      for (let i = 0; i < count; i++) states.push(active[this.#next++ % active.length]!);
      for (const state of states) {
        ctx.assertCurrent();
        const reply = await ctx.wait(this.#reader.read({ kind: 'scan', runtime: runtimeInput(state.binding),
          rootId: state.binding.providerSessionId, cursor: state.cursor }));
        ctx.assertCurrent();
        if (this.#stopped || !reply?.valid) continue;
        state.highWatermark = Math.max(state.highWatermark, reply.highWatermark);
        state.cursor = reply.fetched < MIMO_SCAN_ROWS
          ? { at: Math.max(0, state.highWatermark - 1), id: '' } : reply.cursor;
        for (const event of reply.events) {
          ctx.assertCurrent();
          if (this.#stopped) return;
          const fingerprint = JSON.stringify(event);
          if (state.seen.get(event.messageId) === fingerprint) continue;
          this.onEvent(state.binding, event);
          state.seen.set(event.messageId, fingerprint);
          if (state.seen.size > MAX_SEEN_MESSAGES) state.seen.delete(state.seen.keys().next().value!);
          await ctx.checkpoint();
        }
      }
    }, { timeoutMs: 20_000, sliceMs: 10 }).catch(() => {
      // Availability/locks/cancellation never stop a pane or advance an unreturned cursor.
    }).finally(() => { this.#flight = null; });
    return this.#flight;
  }
  stop(): Promise<void> {
    if (this.#stopFlight) return this.#stopFlight;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const physical = this.#reader.stop();
    const periodic = stopPeriodicTask(this.#taskId);
    this.#stopFlight = Promise.all([physical, periodic, this.#flight]).then(() => {
      this.#states.clear(); this.#retired.length = 0;
    });
    return this.#stopFlight;
  }
}
