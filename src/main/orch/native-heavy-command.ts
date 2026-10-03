import type http from 'node:http';
import { z } from 'zod';
import type { AgentGateContext } from './gate';
import { isCurrentGateContext, gateContextAbortSignal } from './gate';
import { handleHookJsonPost } from './hook-http';
import { acquireHeavyCommandPermit, type HeavyCommandPermit, type HeavyCommandRequest } from './heavy-command-permit';
import { claimSessionCommandProcess, probeSessionCommandProcess, getSessionState } from '../pty/pty-manager';
import type { CommandProcessState } from '../pty/owned-command-process';
const schema = z.object({ pid: z.number().int().positive(), kind: z.literal('typescript') }).strict();
export interface NativeHeavyCommandPorts {
  current(ctx: AgentGateContext): boolean;
  claim(sessionId: string, pid: number): Promise<string | null>;
  probe(sessionId: string, claim: string): Promise<CommandProcessState>;
  exited(sessionId: string): boolean;
  acquire(request: HeavyCommandRequest): Promise<HeavyCommandPermit>;
}
interface Flight { ctx: AgentGateContext; claim: string; permit: HeavyCommandPermit; done: Promise<void> }
/** No remote release endpoint. Kernel identity disappearance or physical PTY
 * proof alone releases RAM/CPU; PostToolUse never does. */
export class NativeHeavyCommands {
  readonly #flights = new Set<Flight>();
  #accepting = true;
  readonly #pending = new Set<Promise<{ allow: boolean; reason?: string; leaseId?: string }>>();
  constructor(private readonly ports: NativeHeavyCommandPorts) {}
  admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }> {
    const pending = this.#admit(ctx, raw, signal); this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending)); return pending;
  }
  async #admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }> {
    const body = schema.safeParse(raw);
    if (!body.success || !ctx.sessionId || !ctx.missionId || ctx.role === 'user' || !this.#accepting || !this.ports.current(ctx)) return { allow: false, reason: 'heavy_command_authority_unavailable' };
    let claim: string | null = null;
    try { claim = await this.ports.claim(ctx.sessionId, body.data.pid); } catch { /* ownership unavailable */ }
    if (!claim || !this.ports.current(ctx) || signal?.aborted) return { allow: false, reason: 'heavy_command_process_ownership_unproved' };
    let permit: HeavyCommandPermit;
    try { permit = await this.ports.acquire({ scope: ctx.scope, missionId: ctx.missionId, sessionId: ctx.sessionId, kind: body.data.kind, signal, isCurrent: () => this.ports.current(ctx) && this.#accepting }); }
    catch { return { allow: false, reason: 'heavy_command_admission_denied' }; }
    const flight: Flight = { ctx, claim, permit, done: Promise.resolve() }; this.#flights.add(flight);
    flight.done = this.#observe(flight); void flight.done.catch(() => {});
    let state: CommandProcessState = 'unknown';
    try { state = await this.ports.probe(ctx.sessionId, claim); } catch { /* unknown is not permission */ }
    if (state !== 'live' || !this.ports.current(ctx) || signal?.aborted) return { allow: false, reason: 'heavy_command_process_ownership_changed' };
    return { allow: true, leaseId: permit.id };
  }
  async #observe(flight: Flight) {
    for (;;) {
      let state: CommandProcessState = 'unknown';
      try { state = await this.ports.probe(flight.ctx.sessionId!, flight.claim); } catch { /* unknown is not exit */ }
      if (state === 'gone' || this.ports.exited(flight.ctx.sessionId!)) { flight.permit.release(); this.#flights.delete(flight); return; }
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 250); timer.unref?.(); });
    }
  }
  startAdmission(): void { this.#accepting = true; }
  stopAdmission(): void { this.#accepting = false; }
  async drain(): Promise<void> { this.stopAdmission(); while (this.#pending.size) await Promise.allSettled([...this.#pending]); await Promise.all([...this.#flights].map((flight) => flight.done)); }
}
export const nativeHeavyCommands = new NativeHeavyCommands({ current: isCurrentGateContext, claim: claimSessionCommandProcess,
  probe: probeSessionCommandProcess, exited: (id) => getSessionState(id) === null, acquire: acquireHeavyCommandPermit });
export async function handleNativeHeavyCommandHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: AgentGateContext | null): Promise<void> {
  const abort = new AbortController();
  const parent = ctx ? gateContextAbortSignal(ctx) : undefined;
  const cancel = () => abort.abort(); parent?.addEventListener('abort', cancel, { once: true });
  const disconnected = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', disconnected);
  try { await handleHookJsonPost(req, res, ctx, 2048, async (body) => ({ statusCode: 200, payload: ctx ? await nativeHeavyCommands.admit(ctx, body, abort.signal) : { allow: false } })); }
  finally { parent?.removeEventListener('abort', cancel); res.removeListener('close', disconnected); }
}
