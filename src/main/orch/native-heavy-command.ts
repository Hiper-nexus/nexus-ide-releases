import type http from 'node:http';
import { z } from 'zod';
import type { AgentGateContext } from './gate';
import { executionScopeFor, isCurrentGateContext, gateContextAbortSignal } from './gate';
import { handleHookJsonPost } from './hook-http';
import { acquireHeavyCommandPermit, type HeavyCommandPermit, type HeavyCommandQueueWait, type HeavyCommandRequest } from './heavy-command-permit';
import { sameRepositoryExecutionRoot } from './nested-worktree-execution';
import type { ProjectExecutionScope } from '../../shared/types';
import { claimSessionCommandProcess, probeSessionCommandProcess, borrowSessionCommandProcess, stopSessionCommandProcess } from '../pty/pty-manager';
import type { CommandProcessState } from '../pty/owned-command-process';
import { trace } from '../observability/main-trace';
const schema = z.object({ pid: z.number().int().positive(), kind: z.enum(['typescript', 'tests', 'build', 'install']), leaseId: z.string().min(1).max(128).optional(), proof: z.literal('darwin-job').optional(), cwd: z.string().min(1).max(1024).optional() }).strict();
type Admission = { allow: boolean; reason?: string; leaseId?: string; message?: string };
export interface NativeHeavyCommandPorts {
  current(ctx: AgentGateContext): boolean;
  claim(sessionId: string, pid: number, proof?: 'darwin-job'): Promise<string | null>;
  probe(sessionId: string, claim: string): Promise<CommandProcessState>;
  borrow?(sessionId: string, claim: string, pid: number): Promise<boolean>;
  stop?(sessionId: string, claim: string): Promise<void>;
  acquire(request: HeavyCommandRequest): Promise<HeavyCommandPermit>;
  /** F-1229: the job's real root when it is this repository's checkout/worktree. */
  executionRoot?(scope: Readonly<ProjectExecutionScope>, cwd: string): Promise<Readonly<ProjectExecutionScope> | undefined>;
  afterDrain?(): Promise<void>;
}
/** F-1229: the 74 says it was a queue wait, for how long and behind what. */
function queueWaitMessage(wait: HeavyCommandQueueWait): string {
  const root = wait.root.length > 160 ? `…${wait.root.slice(-159)}` : wait.root;
  const cause = wait.running > 0 ? 'one job per root at a time' : 'machine CPU/RAM bound, not this root';
  return `nexus-heavy: gave up after ${Math.round(wait.waitedMs / 1000)} s in the admission queue of ${root}: ` +
    `${wait.running} job(s) running there, ${wait.waiting} more waiting (${cause}); machine ${wait.machineActive}/${wait.maxActive} heavy jobs running.`;
}
interface Flight { ctx: AgentGateContext; claim: string; permit: HeavyCommandPermit; done: Promise<void> }
/** No remote release endpoint. Kernel identity disappearance or physical PTY
 * proof alone releases RAM/CPU; PostToolUse never does. */
export class NativeHeavyCommands {
  readonly #flights = new Set<Flight>();
  readonly #orphans = new Map<Promise<void>, AgentGateContext>();
  readonly #retired = new WeakSet<AgentGateContext>();
  #accepting = true;
  readonly #pending = new Map<Promise<Admission>, AgentGateContext>();
  constructor(private readonly ports: NativeHeavyCommandPorts) {}
  admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<Admission> {
    const started = Date.now();
    const pending = this.#admit(ctx, raw, signal); this.#pending.set(pending, ctx);
    void pending.then((result) => {
      this.#pending.delete(pending);
      // F-997: o "exit 74/78" do pane ganha causa no trace do Main.
      if (!result.allow) trace({ kind: 'heavy-command-denied', sessionId: ctx.sessionId ?? '', reason: result.reason ?? 'unknown', elapsedMs: Date.now() - started });
    }, () => this.#pending.delete(pending)); return pending;
  }
  async #admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<Admission> {
    const body = schema.safeParse(raw);
    if (!body.success || !ctx.sessionId || !this.#accepting || !this.#current(ctx)) return { allow: false, reason: 'heavy_command_authority_unavailable' };
    if (body.data.leaseId) {
      const flight = [...this.#flights].find((candidate) => candidate.permit.id === body.data.leaseId && candidate.ctx.token === ctx.token && candidate.ctx.sessionId === ctx.sessionId);
      let proved = false;
      try { proved = Boolean(flight && await this.ports.borrow?.(ctx.sessionId, flight.claim, body.data.pid)); } catch { /* fail closed */ }
      return proved && Boolean(flight && this.#flights.has(flight)) && this.#accepting && this.#current(ctx) && !signal?.aborted
        ? { allow: true, leaseId: body.data.leaseId }
        : { allow: false, reason: 'heavy_command_nested_ownership_unproved' };
    }
    let claim: string | null = null;
    try { claim = await this.ports.claim(ctx.sessionId, body.data.pid, body.data.proof); } catch { /* ownership unavailable */ }
    if (!claim || !this.#accepting || !this.#current(ctx) || signal?.aborted) { if (claim) this.#reap(ctx, claim); return { allow: false, reason: 'heavy_command_process_ownership_unproved' }; }
    let permit: HeavyCommandPermit;
    // F-983/F-997: a fila é por raiz de EXECUÇÃO (a worktree do writer), não
    // pelo checkout de coordenação do token — senão writers isolados voltam à
    // fila única do projeto. F-1229: e a raiz é a do cwd do job, se for deste
    // repositório (subagentes do mesmo token, cada um na sua worktree).
    try { permit = await this.ports.acquire({ scope: await this.#executionScope(ctx, body.data.cwd, body.data.pid), missionId: ctx.missionId, sessionId: ctx.sessionId, kind: body.data.kind, signal, isCurrent: () => this.#current(ctx) && this.#accepting }); }
    catch (failure) {
      this.#reap(ctx, claim);
      const wait = (failure as { queue?: HeavyCommandQueueWait } | null)?.queue;
      return wait ? { allow: false, reason: 'heavy_command_wait_timeout', message: queueWaitMessage(wait) } : { allow: false, reason: 'heavy_command_admission_denied' };
    }
    const flight: Flight = { ctx, claim, permit, done: Promise.resolve() }; this.#flights.add(flight);
    flight.done = this.#observe(flight); void flight.done.catch(() => {});
    let state: CommandProcessState = 'unknown';
    try { state = await this.ports.probe(ctx.sessionId, claim); } catch { /* unknown is not permission */ }
    if (state !== 'live' || !this.#flights.has(flight) || !this.#accepting || !this.#current(ctx) || signal?.aborted) return { allow: false, reason: 'heavy_command_process_ownership_changed' };
    return { allow: true, leaseId: permit.id };
  }
  async #executionScope(ctx: AgentGateContext, cwd: string | undefined, pid: number): Promise<Readonly<ProjectExecutionScope>> {
    const scope = executionScopeFor(ctx);
    // A spoofed cwd only picks another registered root's serialization; RAM/CPU stay machine-wide.
    let lane: Readonly<ProjectExecutionScope> | undefined;
    try { lane = cwd ? await this.ports.executionRoot?.(scope, cwd) : undefined; } catch { lane = undefined; }
    if (!lane || lane.rootRealPath === scope.rootRealPath) return scope;
    // F-1235: the request, not the token, picked this lane — auditable in the Main trace.
    trace({ kind: 'heavy-command-lane', sessionId: ctx.sessionId ?? '', pid, root: lane.rootRealPath, paneRoot: scope.rootRealPath });
    return lane;
  }
  #reap(ctx: AgentGateContext, claim: string) {
    const done = (async () => {
      for (;;) {
        let state: CommandProcessState = 'unknown'; try { state = await this.ports.probe(ctx.sessionId!, claim); } catch {}
        if (state === 'gone') return;
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 250); timer.unref?.(); });
      }
    })();
    this.#orphans.set(done, ctx); void done.then(() => this.#orphans.delete(done), () => this.#orphans.delete(done));
  }
  async #observe(flight: Flight) {
    for (;;) {
      let state: CommandProcessState = 'unknown';
      try { state = await this.ports.probe(flight.ctx.sessionId!, flight.claim); } catch { /* unknown is not exit */ }
      if (state === 'gone') { flight.permit.release(); this.#flights.delete(flight); return; }
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 250); timer.unref?.(); });
    }
  }
  startAdmission(): void { this.#accepting = true; }
  stopAdmission(): void { this.#accepting = false; }
  async drainContext(ctx: AgentGateContext): Promise<void> {
    this.#retired.add(ctx);
    for (;;) { const pending = [...this.#pending].filter(([, owner]) => owner === ctx).map(([done]) => done); if (!pending.length) break; await Promise.allSettled(pending); }
    const flights = [...this.#flights].filter(flight => flight.ctx === ctx);
    await Promise.all(flights.map(flight => this.ports.stop?.(ctx.sessionId!, flight.claim)));
    await Promise.all(flights.map(flight => flight.done));
    await Promise.all([...this.#orphans].filter(([, owner]) => owner === ctx).map(([done]) => done));
  }
  #current(ctx: AgentGateContext): boolean { return !this.#retired.has(ctx) && this.ports.current(ctx); }
  async drain(): Promise<void> { this.stopAdmission(); while (this.#pending.size) await Promise.allSettled([...this.#pending.keys()]); await Promise.all([...this.#flights].map((flight) => this.ports.stop?.(flight.ctx.sessionId!, flight.claim))); await Promise.all([...this.#flights].map((flight) => flight.done)); await Promise.all([...this.#orphans.keys()]); await this.ports.afterDrain?.(); }
}
export const nativeHeavyCommands = new NativeHeavyCommands({ current: isCurrentGateContext, claim: claimSessionCommandProcess,
  probe: probeSessionCommandProcess, stop: stopSessionCommandProcess, borrow: borrowSessionCommandProcess, acquire: acquireHeavyCommandPermit,
  executionRoot: (scope, cwd) => sameRepositoryExecutionRoot(scope, cwd),
  afterDrain: async () => { const { drainNativeHeavyLocalChannels } = await import('./native-heavy-local-channel'); await drainNativeHeavyLocalChannels(); } });
export async function handleNativeHeavyCommandHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: AgentGateContext | null): Promise<void> {
  const abort = new AbortController();
  const parent = ctx ? gateContextAbortSignal(ctx) : undefined;
  const cancel = () => abort.abort(); parent?.addEventListener('abort', cancel, { once: true });
  const disconnected = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', disconnected);
  try { await handleHookJsonPost(req, res, ctx, 2048, async (body) => ({ statusCode: 200, payload: ctx ? await nativeHeavyCommands.admit(ctx, body, abort.signal) : { allow: false } })); }
  finally { parent?.removeEventListener('abort', cancel); res.removeListener('close', disconnected); }
}
