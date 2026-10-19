import type http from 'node:http';
import { z } from 'zod';
import type { AgentGateContext } from './gate';
import { executionScopeFor, isCurrentGateContext, gateContextAbortSignal } from './gate';
import { handleHookJsonPost } from './hook-http';
import { acquireHeavyCommandPermit, heavyCommandLabel, setHeavyCommandPermitLiveness, type HeavyCommandPermit, type HeavyCommandQueueWait, type HeavyCommandRequest } from './heavy-command-permit';
import { heavyCommandExecutionRoot } from './nested-worktree-execution';
import type { ProjectExecutionScope } from '../../shared/types';
import { claimSessionCommandProcess, probeSessionCommandProcess, borrowSessionCommandProcess, stopSessionCommandProcess, getAgentSessionInfo } from '../pty/pty-manager';
import type { CommandProcessState } from '../pty/owned-command-process';
import { trace } from '../observability/main-trace';
const TICKET = /^hq-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema = z.object({ pid: z.number().int().positive(), kind: z.enum(['typescript', 'tests', 'build', 'install']), leaseId: z.string().min(1).max(128).optional(), proof: z.literal('darwin-job').optional(), cwd: z.string().min(1).max(1024).optional(), ticket: z.string().regex(TICKET).optional(), label: z.string().max(80).optional() }).strict();
type AdmissionBody = z.infer<typeof schema>;
type Admission = { allow: boolean; reason?: string; leaseId?: string; message?: string; ticket?: string };
const PROGRESS_AFTER_MS = 20_000;
export interface NativeHeavyCommandPorts {
  current(ctx: AgentGateContext): boolean;
  claim(sessionId: string, pid: number, proof?: 'darwin-job'): Promise<string | null>;
  probe(sessionId: string, claim: string): Promise<CommandProcessState>;
  borrow?(sessionId: string, claim: string, pid: number): Promise<boolean>;
  stop?(sessionId: string, claim: string): Promise<void>;
  acquire(request: HeavyCommandRequest): Promise<HeavyCommandPermit>;
  /** F-1229: the job's real root when it is this repository's checkout/worktree. */
  executionRoot?(scope: Readonly<ProjectExecutionScope>, cwd: string): Promise<Readonly<ProjectExecutionScope> | undefined>;
  /** Admitted executor still alive. Absent: fake pids keep the slot until the authority probe is gone. */
  executorLive?(pid: number): boolean;
  afterDrain?(): Promise<void>;
}
/** kill(pid, 0). ESRCH is gone; EPERM is alive. Any other error keeps the slot.
 * A pid reused inside the 250 ms poll stays live until the authority exits. */
export function heavyExecutorIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function occupantText(occupant: HeavyCommandQueueWait['occupants'][number]): string {
  const who = occupant.paneId ? `pane ${occupant.paneId}` : occupant.sessionId ? `session ${occupant.sessionId}` : 'a job';
  const what = occupant.label ? `${occupant.kind} ${occupant.label}` : occupant.kind;
  return `${who} ${what} for ${Math.max(0, Math.round(occupant.ageMs / 1000))} s`;
}
/** Occupants shown in full; the rest collapse to "+N more". */
const MAX_SHOWN_OCCUPANTS = 3;
/**
 * The HTTP/file transports refuse a reply over 2048 B (request.cjs destroys the
 * round) — a longer queued message was silently discarded and the caller saw
 * only an unreadable reply. Keep the whole message far below that ceiling,
 * counted in UTF-8 bytes: a path of non-ASCII chars is not one byte each.
 */
export const MAX_QUEUE_MESSAGE_BYTES = 1200;
function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // The ellipsis itself is 3 bytes: budget for it before trimming.
  let out = text;
  const limit = maxBytes - 3;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > limit) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}
/** F-1229: the refusal names who holds the slot, the command and for how long. */
export function queueWaitMessage(wait: HeavyCommandQueueWait, mode: 'gave-up' | 'waiting' = 'gave-up'): string {
  const root = wait.root.length > 160 ? `…${wait.root.slice(-159)}` : wait.root;
  // F-1434: RAM is named only when free RAM was really below the reserve.
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  const shownOccupants = wait.occupants.slice(0, MAX_SHOWN_OCCUPANTS).map(occupantText).join(', ');
  const overflow = wait.occupants.length - MAX_SHOWN_OCCUPANTS;
  const held = wait.occupants.length
    ? ` (held by ${shownOccupants}${overflow > 0 ? ` and ${overflow} more` : ''})`
    : '';
  const cause = wait.blockedBy === 'exclusive' ? `exclusive build or install on this root${held}`
    : wait.blockedBy === 'writer-ahead' ? 'a build or install is ahead in the queue'
    : wait.blockedBy === 'pressure' ? 'esperando: pressão de memória'
    : wait.blockedBy === 'swap' ? 'swap use above the configured limit'
    : wait.blockedBy === 'ram' && wait.memory && wait.memory.freeMB !== null && wait.memory.freeMB < wait.memory.neededMB
      ? `free RAM ${gb(wait.memory.freeMB)} GB below the ${gb(wait.memory.neededMB)} GB reserve`
    : wait.blockedBy === 'machine' ? `machine limit of ${wait.maxActive} parallel heavy jobs`
    : 'machine capacity, not this root';
  const shownMax = wait.blockedBy === 'pressure' ? (wait.effectiveMaxActive ?? wait.maxActive) : wait.maxActive;
  const verb = mode === 'waiting' ? 'still waiting after' : 'gave up after';
  return clampBytes(
    `nexus-heavy: ${verb} ${Math.round(wait.waitedMs / 1000)} s in the admission queue of ${root}: ` +
      `${wait.running} job(s) running there, ${wait.waiting} more waiting (${cause}); machine ${wait.machineActive}/${shownMax} heavy jobs running.`,
    MAX_QUEUE_MESSAGE_BYTES,
  );
}
/** F-1434: every refusal carries the line the shell prints; none blames CPU/RAM. */
function denied(reason: string, detail: string): Admission {
  return { allow: false, reason, message: `nexus-heavy: ${detail}` };
}
const POOL_REFUSALS: Readonly<Record<string, string>> = {
  heavy_command_closed: 'Nexus is shutting down and no longer admits heavy commands',
  heavy_command_aborted: 'the admission request was cancelled before a slot opened',
  heavy_command_queue_full: 'too many heavy commands are already waiting for admission',
  heavy_command_authority_revoked: 'this terminal lost its Nexus authority while waiting for a slot',
};
interface Flight { ctx: AgentGateContext; claim: string; permit: HeavyCommandPermit; pid: number; slotReleased: boolean; done: Promise<void> }
interface QueuedHold { ctx: AgentGateContext; claim: string; pid: number }
/** No remote release endpoint. Kernel identity disappearance or physical PTY
 * proof alone releases RAM/CPU; PostToolUse never does. */
export class NativeHeavyCommands {
  readonly #flights = new Set<Flight>();
  readonly #holds = new Map<string, QueuedHold>();
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
      if (!result.allow && result.reason !== 'heavy_command_queued') trace({ kind: 'heavy-command-denied', sessionId: ctx.sessionId ?? '', reason: result.reason ?? 'unknown', elapsedMs: Date.now() - started });
    }, () => this.#pending.delete(pending)); return pending;
  }
  async #admit(ctx: AgentGateContext, raw: unknown, signal?: AbortSignal): Promise<Admission> {
    const body = schema.safeParse(raw);
    if (!body.success) return denied('heavy_command_authority_unavailable', 'malformed admission request');
    if (!ctx.sessionId || !this.#accepting || !this.#current(ctx)) return denied('heavy_command_authority_unavailable', 'this terminal has no live Nexus admission authority (pane closed or Nexus shutting down)');
    if (body.data.ticket && !body.data.leaseId) {
      const hold = this.#holds.get(body.data.ticket);
      if (hold && hold.ctx.token === ctx.token && hold.ctx.sessionId === ctx.sessionId && hold.pid === body.data.pid) {
        if (!this.#accepting || !this.#current(ctx) || signal?.aborted) {
          this.#holds.delete(body.data.ticket);
          this.#reap(ctx, hold.claim);
          return denied('heavy_command_authority_unavailable', 'this terminal lost its Nexus authority while waiting for a slot');
        }
        return this.#acquireHeld(ctx, hold.claim, body.data, signal);
      }
    }
    if (body.data.leaseId) {
      const flight = [...this.#flights].find((candidate) => candidate.permit.id === body.data.leaseId && candidate.ctx.token === ctx.token && candidate.ctx.sessionId === ctx.sessionId);
      let proved = false;
      try { proved = Boolean(flight && await this.ports.borrow?.(ctx.sessionId, flight.claim, body.data.pid)); } catch { /* fail closed */ }
      return proved && Boolean(flight && this.#flights.has(flight)) && this.#accepting && this.#current(ctx) && !signal?.aborted
        ? { allow: true, leaseId: body.data.leaseId }
        : denied('heavy_command_nested_ownership_unproved', `the inherited admission could not be proved for pid ${body.data.pid}`);
    }
    let claim: string | null = null;
    try { claim = await this.ports.claim(ctx.sessionId, body.data.pid, body.data.proof); } catch { /* ownership unavailable */ }
    if (!claim || !this.#accepting || !this.#current(ctx) || signal?.aborted) {
      if (claim) this.#reap(ctx, claim);
      return denied('heavy_command_process_ownership_unproved', claim
        ? 'this terminal lost its Nexus authority during admission'
        : `could not prove that pid ${body.data.pid} runs inside this agent terminal's process tree`);
    }
    return this.#acquireHeld(ctx, claim, body.data, signal);
  }
  async #acquireHeld(ctx: AgentGateContext, claim: string, body: AdmissionBody, signal?: AbortSignal): Promise<Admission> {
    let permit: HeavyCommandPermit;
    // F-983/F-997: a fila é por raiz de EXECUÇÃO (a worktree do writer), não
    // pelo checkout de coordenação do token — senão writers isolados voltam à
    // fila única do projeto. F-1229: e a raiz é a do cwd do job, se for deste
    // repositório (subagentes do mesmo token, cada um na sua worktree).
    // Progress is per HTTP round: in-process terminal/bg callers omit it and
    // keep the promise until the slot opens.
    try { permit = await this.ports.acquire({ scope: await this.#executionScope(ctx, body.cwd, body.pid), missionId: ctx.missionId, sessionId: ctx.sessionId, label: heavyCommandLabel(body.label), kind: body.kind, executorPid: body.pid, signal, isCurrent: () => this.#current(ctx) && this.#accepting, progressAfterMs: PROGRESS_AFTER_MS, queueTicket: body.ticket }); }
    catch (failure) {
      const queued = failure as { message?: string; ticket?: string; queue?: HeavyCommandQueueWait } | null;
      if (queued?.message === 'heavy_command_queued' && queued.ticket && queued.queue) {
        this.#holds.set(queued.ticket, { ctx, claim, pid: body.pid });
        return { allow: false, reason: 'heavy_command_queued', ticket: queued.ticket, message: queueWaitMessage(queued.queue, 'waiting') };
      }
      if (body.ticket) this.#holds.delete(body.ticket);
      this.#reap(ctx, claim);
      const wait = (failure as { queue?: HeavyCommandQueueWait } | null)?.queue;
      if (wait) return { allow: false, reason: 'heavy_command_wait_timeout', message: queueWaitMessage(wait) };
      const code = failure instanceof Error ? failure.message : '';
      return denied('heavy_command_admission_denied', POOL_REFUSALS[code] ?? `admission failed (${code || 'unknown'})`);
    }
    if (body.ticket) this.#holds.delete(body.ticket);
    const flight: Flight = { ctx, claim, permit, pid: body.pid, slotReleased: false, done: Promise.resolve() }; this.#flights.add(flight);
    flight.done = this.#observe(flight); void flight.done.catch(() => {});
    let state: CommandProcessState = 'unknown';
    try { state = await this.ports.probe(ctx.sessionId!, claim); } catch { /* unknown is not permission */ }
    if (state !== 'live' || !this.#flights.has(flight) || !this.#accepting || !this.#current(ctx) || signal?.aborted) {
      return denied('heavy_command_process_ownership_changed', `pid ${body.pid} exited or changed while it was being admitted`);
    }
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
      // B's admit pid dies when the direct job exits. A (the probe) stays up
      // while the responsibility cohort drains. The root slot follows B;
      // this flight stays so drain/stop can still signal A.
      if (!flight.slotReleased && this.ports.executorLive) {
        let live = true;
        try { live = this.ports.executorLive(flight.pid); } catch { live = true; }
        if (!live) { flight.slotReleased = true; flight.permit.release(); }
      }
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
  executorLive: heavyExecutorIsLive,
  executionRoot: (scope, cwd) => heavyCommandExecutionRoot(scope, cwd),
  afterDrain: async () => { const { drainNativeHeavyLocalChannels } = await import('./native-heavy-local-channel'); await drainNativeHeavyLocalChannels(); } });
// Ghost-lease TTL: give the permit pool the same pid/session checks #observe
// uses, so a lease whose watcher proof is stuck on daemon-inherited processes
// still expires once the executor or the owning session is provably gone.
setHeavyCommandPermitLiveness({ executorLive: heavyExecutorIsLive, sessionLive: (sessionId) => Boolean(getAgentSessionInfo(sessionId)) });
export async function handleNativeHeavyCommandHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: AgentGateContext | null): Promise<void> {
  const abort = new AbortController();
  const parent = ctx ? gateContextAbortSignal(ctx) : undefined;
  const cancel = () => abort.abort(); parent?.addEventListener('abort', cancel, { once: true });
  const disconnected = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', disconnected);
  try { await handleHookJsonPost(req, res, ctx, 2048, async (body) => ({ statusCode: 200, payload: ctx ? await nativeHeavyCommands.admit(ctx, body, abort.signal) : { allow: false } })); }
  finally { parent?.removeEventListener('abort', cancel); res.removeListener('close', disconnected); }
}
