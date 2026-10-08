import type http from 'node:http';
import { z } from 'zod';
import type { AgentGateContext } from './gate';
import { executionScopeFor, isCurrentGateContext, gateContextAbortSignal } from './gate';
import { handleHookJsonPost } from './hook-http';
import { acquireHeavyCommandPermit, type HeavyCommandPermit, type HeavyCommandRequest } from './heavy-command-permit';
import { claimSessionCommandProcess, probeSessionCommandProcess, borrowSessionCommandProcess, stopSessionCommandProcess } from '../pty/pty-manager';
import type { CommandProcessState } from '../pty/owned-command-process';
const schema = z.object({ pid: z.number().int().positive(), kind: z.enum(['typescript', 'tests', 'build', 'install']), leaseId: z.string().min(1).max(128).optional(), proof: z.literal('darwin-job').optional() }).strict();
export interface NativeHeavyCommandPorts {
  current(ctx: AgentGateContext): boolean;
  claim(sessionId: string, pid: number, proof?: 'darwin-job'): Promise<string | null>;
  probe(sessionId: string, claim: string): Promise<CommandProcessState>;
  borrow?(sessionId: string, claim: string, pid: number): Promise<boolean>;
  stop?(sessionId: string, claim: string): Promise<void>;
  acquire(request: HeavyCommandRequest): Promise<HeavyCommandPermit>;
  afterDrain?(): Promise<void>;
}
interface Flight { ctx: AgentGateContext; claim: string; permit: HeavyCommandPermit; done: Promise<void> }
/** No remote release endpoint. Kernel identity disappearance or physical PTY
 * proof alone releases RAM/CPU; PostToolUse never does. */
export class NativeHeavyCommands {
  readonly #flights = new Set<Flight>();
  readonly #orphans = new Map<Promise<void>, AgentGateContext>();
  readonly #retired = new WeakSet<AgentGateContext>();
  #accepting = true;
  readonly #pending = new Map<Promise<{ allow: boolean; reason?: string; leaseId?: string }>, AgentGateContext>();
  constructor(private readonly ports: NativeHeavyCommandPorts) {}
  admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }> {
    const pending = this.#admit(ctx, raw, signal); this.#pending.set(pending, ctx);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending)); return pending;
  }
  async #admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }> {
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
    // F-957/F-971: a fila é por raiz de EXECUÇÃO (a worktree do writer), não
    // pelo checkout de coordenação do token — senão writers isolados voltam à
    // fila única do projeto.
    try { permit = await this.ports.acquire({ scope: executionScopeFor(ctx), missionId: ctx.missionId, sessionId: ctx.sessionId, kind: body.data.kind, signal, isCurrent: () => this.#current(ctx) && this.#accepting }); }
    catch { this.#reap(ctx, claim); return { allow: false, reason: 'heavy_command_admission_denied' }; }
    const flight: Flight = { ctx, claim, permit, done: Promise.resolve() }; this.#flights.add(flight);
    flight.done = this.#observe(flight); void flight.done.catch(() => {});
    let state: CommandProcessState = 'unknown';
    try { state = await this.ports.probe(ctx.sessionId, claim); } catch { /* unknown is not permission */ }
    if (state !== 'live' || !this.#flights.has(flight) || !this.#accepting || !this.#current(ctx) || signal?.aborted) return { allow: false, reason: 'heavy_command_process_ownership_changed' };
    return { allow: true, leaseId: permit.id };
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
  afterDrain: async () => { const { drainNativeHeavyLocalChannels } = await import('./native-heavy-local-channel'); await drainNativeHeavyLocalChannels(); } });
export async function handleNativeHeavyCommandHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: AgentGateContext | null): Promise<void> {
  const abort = new AbortController();
  const parent = ctx ? gateContextAbortSignal(ctx) : undefined;
  const cancel = () => abort.abort(); parent?.addEventListener('abort', cancel, { once: true });
  const disconnected = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', disconnected);
  try { await handleHookJsonPost(req, res, ctx, 2048, async (body) => ({ statusCode: 200, payload: ctx ? await nativeHeavyCommands.admit(ctx, body, abort.signal) : { allow: false } })); }
  finally { parent?.removeEventListener('abort', cancel); res.removeListener('close', disconnected); }
}
