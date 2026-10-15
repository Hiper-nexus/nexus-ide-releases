import { captureNativeHeavyProcessSnapshot } from './native-heavy-process-snapshot';
import type { PhysicalCommandClaim } from './darwin-heavy-command';
import { randomUUID } from 'node:crypto';
import { hasUnambiguousStartIdentity, type DescendantSnapshot, type ProcessTableRow } from './pty-descendant-termination';
export type CommandProcessState = 'live' | 'gone' | 'unknown';
interface Root { pid: number; identity: object }
interface Claim { sessionId: string; rootIdentity: object; rows: Map<number, { row: ProcessTableRow; observedAt: number }>; root: ProcessTableRow; physical?: PhysicalCommandClaim }
/** Host-owned process identities. No caller PID ever authorizes an external
 * process; admission requires ancestry in the exact live PTY snapshot. */
export class OwnedCommandProcesses {
  readonly #claims = new Map<string, Claim>();
  readonly #requests = new Map<string, { sessionId: string; cancelled: boolean; claimId: string | null }>();
  readonly #gone = new Map<string, string>();
  constructor(private readonly rootFor: (sessionId: string) => Root | null,
    private readonly capture: (pid: number) => Promise<DescendantSnapshot | null> = captureNativeHeavyProcessSnapshot,
    private readonly watch?: (pid: number) => Promise<PhysicalCommandClaim | null>,
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep: (ms) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) }) {}
  async claim(sessionId: string, pid: number, proof?: 'darwin-job'): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const root = this.rootFor(sessionId); if (!root || root.pid === pid) return null;
    const snapshot = await this.capture(root.pid);
    if (!snapshot?.root || this.rootFor(sessionId)?.identity !== root.identity) return null;
    // A Main RPC timeout may leave an unobserved claim. Physical disappearance
    // still frees its host slot without inventing exit or forgetting live work.
    for (const [id, claim] of this.#claims) {
      if (claim.physical) { if (claim.physical.state() === 'gone') this.#rememberGone(id, claim.sessionId); continue; }
      const gone = [...claim.rows.values()].every(({ row }) => {
        const current = snapshot.inventory.filter((candidate) => candidate.pid === row.pid);
        return current.length === 0 || current.length === 1 && current[0].startedAt !== row.startedAt;
      });
      if (gone) this.#rememberGone(id, claim.sessionId);
    }
    if (this.#claims.size >= 128) return null;
    const row = snapshot.descendants.find((candidate) => candidate.pid === pid);
    if (!row || !hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)) return null;
    let physical: PhysicalCommandClaim | undefined;
    if (proof) {
      physical = await this.watch?.(pid) ?? undefined;
      const after = await this.capture(root.pid);
      if (!physical || physical.state() !== 'live' || this.rootFor(sessionId)?.identity !== root.identity ||
          !after?.descendants.some((current) => current.pid === pid && current.startedAt === row.startedAt) || this.#claims.size >= 128) return null;
    }
    const id = randomUUID();
    this.#claims.set(id, { ...(physical ? { physical } : {}), sessionId, rootIdentity: root.identity, root: row, rows: new Map([[row.pid, { row, observedAt: snapshot.capturedAtMs }]]) });
    return id;
  }
  /** Only the Main/host RPC can cancel a tentative claim; no permit exists yet. */
  async claimForRequest(sessionId: string, requestId: string, pid: number, proof?: 'darwin-job'): Promise<string | null> {
    if (this.#requests.size >= 128 || this.#requests.has(requestId)) return null;
    const entry = { sessionId, cancelled: false, claimId: null as string | null };
    this.#requests.set(requestId, entry);
    let id: string | null = null;
    try { id = await this.claim(sessionId, pid, proof); }
    catch { this.#requests.delete(requestId); return null; }
    if (entry.cancelled) {
      if (id) this.#claims.delete(id);
      this.#requests.delete(requestId); return null;
    }
    if (!id) this.#requests.delete(requestId); else entry.claimId = id;
    return id;
  }
  confirmRequest(sessionId: string, requestId: string, claimId: string): void {
    const entry = this.#requests.get(requestId);
    if (entry?.sessionId === sessionId && !entry.cancelled && entry.claimId === claimId) this.#requests.delete(requestId);
  }
  cancelRequest(sessionId: string, requestId: string): void {
    const entry = this.#requests.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return;
    entry.cancelled = true;
    if (entry.claimId) { this.#claims.delete(entry.claimId); this.#requests.delete(requestId); }
  }
  /** Borrowing is a host proof, never trust in an inherited lease string. */
  async borrow(sessionId: string, id: string, pid: number): Promise<boolean> {
    const claim = this.#claims.get(id);
    if (!claim || claim.sessionId !== sessionId || !Number.isSafeInteger(pid) || pid <= 0) return false;
    if (claim.physical) {
      const borrowed = await claim.physical.borrow(pid);
      return borrowed && this.#claims.get(id) === claim && claim.physical.state() === 'live';
    }
    let snapshot = await this.capture(claim.root.pid);
    if (this.#claims.get(id) !== claim || !snapshot?.root || snapshot.root.startedAt !== claim.root.startedAt) return false;
    let row = pid === claim.root.pid ? snapshot.root : snapshot.descendants.find((candidate) => candidate.pid === pid);
    // F-1544: o filho de um comando pesado pede o lease no primeiro segundo de
    // vida (`node install.js`, `electron-forge`), quando a cerca de "mesmo
    // segundo" ainda o chama de ambíguo — e a recusa virava exit 78. A cerca
    // continua intacta: espera a virada do segundo e reamostra UMA vez; só então
    // decide. Pid ausente, outro pai ou identidade ainda ambígua seguem negados.
    if (row && !hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)) {
      const wait = Math.floor(snapshot.capturedAtMs / 1_000) * 1_000 + 1_000 - this.clock.now() + 25;
      if (wait > 0 && wait <= 1_500) {
        await this.clock.sleep(wait);
        snapshot = await this.capture(claim.root.pid);
        if (this.#claims.get(id) !== claim || !snapshot?.root || snapshot.root.startedAt !== claim.root.startedAt) return false;
        row = pid === claim.root.pid ? snapshot.root : snapshot.descendants.find((candidate) => candidate.pid === pid);
      }
    }
    if (!row || !hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)) return false;
    const merged = new Map(claim.rows);
    for (const member of [row, ...snapshot.descendants]) {
      const prior = merged.get(member.pid);
      if (prior && prior.row.startedAt !== member.startedAt) return false;
      if (!prior) merged.set(member.pid, { row: member, observedAt: snapshot.capturedAtMs });
    }
    if (merged.size > 256) return false;
    claim.rows = merged;
    return true;
  }
  async probe(sessionId: string, id: string): Promise<CommandProcessState> {
    if (this.#gone.get(id) === sessionId) return 'gone';
    const claim = this.#claims.get(id); if (!claim || claim.sessionId !== sessionId) return 'unknown';
    if (claim.physical) { const state = claim.physical.state(); if (state === 'gone') this.#rememberGone(id, sessionId); return state; }
    const snapshot = await this.capture(claim.root.pid); if (!snapshot) return 'unknown';
    if (snapshot.root?.startedAt === claim.root.startedAt) for (const row of snapshot.descendants) {
      if (!claim.rows.has(row.pid)) {
        if (claim.rows.size >= 256) return 'unknown';
        claim.rows.set(row.pid, { row, observedAt: snapshot.capturedAtMs });
      }
    }
    let live = false; let ambiguous = false;
    for (const expected of claim.rows.values()) {
      const current = snapshot.inventory.filter((row) => row.pid === expected.row.pid);
      if (!current.length || (current.length === 1 && current[0].startedAt !== expected.row.startedAt)) continue;
      if (current.length !== 1 || !hasUnambiguousStartIdentity(expected.row, expected.observedAt)) ambiguous = true;
      else live = true;
    }
    if (live) return 'live'; if (ambiguous) return 'unknown';
    this.#rememberGone(id, sessionId);
    return 'gone';
  }
  async stop(sessionId: string, id: string): Promise<void> {
    if (this.#gone.get(id) === sessionId) return;
    const claim = this.#claims.get(id);
    if (!claim || claim.sessionId !== sessionId || !claim.physical?.stop) throw new Error('native_heavy_authority_exit_unproved');
    await claim.physical.stop();
    if (claim.physical.state() !== 'gone') throw new Error('native_heavy_authority_exit_unproved');
    this.#rememberGone(id, sessionId);
  }
  #rememberGone(id: string, sessionId: string): void {
    this.#claims.delete(id); this.#gone.set(id, sessionId);
    while (this.#gone.size > 256) this.#gone.delete(this.#gone.keys().next().value!);
  }
}
