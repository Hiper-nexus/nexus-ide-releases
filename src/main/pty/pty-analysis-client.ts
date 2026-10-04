import {
  ANALYSIS_GLOBAL_BYTES, ANALYSIS_SESSION_BYTES, ANALYSIS_UNIT_BYTES,
  validAnalysisResult, type AnalysisBinding, type AnalysisConsumer,
  type AnalysisEvent, type AnalysisFence, type AnalysisInput, type AnalysisResult,
} from './pty-analysis-protocol';

type InputBody<T = AnalysisInput> = T extends AnalysisFence ? Omit<T, keyof AnalysisFence> : never;
interface Session {
  totalAdmitted: number; totalAcked: number; generation: number; seq: number; lastDataSeq: number; accepted: number; queue: AnalysisInput[];
  bytes: number; status: 'active' | 'sealed' | 'degraded' | 'terminated';
  paused: boolean; text: string; latest: Map<AnalysisConsumer, { value: unknown; fence: AnalysisFence }>; evidence: Map<AnalysisConsumer, unknown[]>;
}
interface Subscription {
  registration: number;
  callback: (sessionId: string, value: unknown, fence: AnalysisFence) => void;
  config?: unknown;
}
export interface AnalysisClientDeps {
  readonly post: (input: AnalysisInput) => void;
  readonly flow: (sessionId: string, paused: boolean) => void;
  readonly now: () => number;
  readonly acknowledged?: (sessionId: string, bytes: number) => void;
  readonly trace?: (event: Record<string, unknown>) => void;
}

/** One outstanding work unit, FIFO per generation, round robin across sessions. */
export class PtyAnalysisClient {
  readonly #sessions = new Map<string, Session>();
  readonly #subscribers = new Map<AnalysisConsumer, Subscription>();
  readonly #registration = new Map<AnalysisConsumer, number>();
  readonly #barriers = new Map<string, { seq: number; resolve: (ok: boolean) => void }[]>();
  #generation = 0; #epoch = 1; #flight: AnalysisInput | null = null;
  #lastSession = ''; #bytes = 0; #admitted = 0; #acked = 0; #highwater = 0;
  #degraded = false;
  constructor(private readonly deps: AnalysisClientDeps) {}

  bind(id: string, binding: AnalysisBinding): number {
    const prior = this.#sessions.get(id);
    if (prior) { this.deps.acknowledged?.(id, prior.bytes); this.#discard(id, prior); }
    const session: Session = { totalAdmitted: prior?.totalAdmitted ?? 0, totalAcked: prior?.totalAcked ?? 0, generation: ++this.#generation, seq: 0, lastDataSeq: 0, accepted: 0,
      queue: [], bytes: 0, status: this.#degraded ? 'degraded' : 'active', paused: false, text: '', latest: new Map(), evidence: new Map() };
    this.#sessions.set(id, session);
    this.#enqueue(id, { kind: 'bind', binding });
    for (const [consumer, sub] of this.#subscribers) this.#enqueue(id, {
      kind: 'arm', consumer, registration: sub.registration, config: sub.config,
    });
    return session.generation;
  }
  has(id: string): boolean { return this.#sessions.has(id); }
  generation(id: string): number | null { return this.#sessions.get(id)?.generation ?? null; }
  status(id: string): Session['status'] | null { return this.#sessions.get(id)?.status ?? null; }
  text(id: string): string { return this.#sessions.get(id)?.text ?? ''; }
  latest(id: string, consumer: AnalysisConsumer) { const s = this.#sessions.get(id); const entry = s?.latest.get(consumer); return entry && entry.fence.eventSeq >= (s?.lastDataSeq ?? Infinity) ? entry : null; }
  evidence(id: string, consumer: AnalysisConsumer): readonly unknown[] { return this.#sessions.get(id)?.evidence.get(consumer) ?? []; }
  data(id: string, data: string): boolean {
    const s = this.#sessions.get(id);
    if (!s || s.status !== 'active') return false;
    const bytes = Buffer.byteLength(data);
    if (s.bytes + bytes > ANALYSIS_SESSION_BYTES || this.#bytes + bytes > ANALYSIS_GLOBAL_BYTES) {
      s.status = 'degraded'; this.#pause(id, s, true);
      this.deps.trace?.({ kind: 'pty-analysis-degraded', sessionId: id, reason: 'queue-overflow', bytes });
      return false;
    }
    // Split by UTF-8 bytes without cutting a surrogate pair. The fast ASCII
    // path avoids encoding/copying an entire multi-megabyte flood in Main.
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + ANALYSIS_UNIT_BYTES / 3);
      if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
      const part = data.slice(start, end);
      const partBytes = Buffer.byteLength(part);
      s.bytes += partBytes; this.#bytes += partBytes; this.#admitted += partBytes; s.totalAdmitted += partBytes;
      this.#enqueue(id, { kind: 'data', data: part, endOfChunk: end === data.length });
      start = end;
    }
    this.#highwater = Math.max(this.#highwater, this.#bytes);
    if (s.bytes >= ANALYSIS_SESSION_BYTES * 0.75) this.#pause(id, s, true);
    return true;
  }
  input(id: string, data: string): void { this.#enqueue(id, { kind: 'input', data }); }
  state(id: string, state: string): void { this.#enqueue(id, { kind: 'state', state }); }
  control(id: string, consumer: AnalysisConsumer, value: unknown): void { this.#enqueue(id, { kind: 'control', consumer, value }); }
  arm(id: string, consumer: AnalysisConsumer, config?: unknown): void {
    const sub = this.#subscribers.get(consumer);
    if (sub) this.#enqueue(id, { kind: 'arm', consumer, registration: sub.registration, config });
  }
  subscribe(consumer: AnalysisConsumer, callback: Subscription['callback'], config?: unknown): () => void {
    const registration = (this.#registration.get(consumer) ?? 0) + 1;
    this.#registration.set(consumer, registration);
    const sub = { registration, callback, config };
    this.#subscribers.set(consumer, sub);
    for (const [id, s] of this.#sessions) if (s.status === 'active') this.#enqueue(id, { kind: 'arm', consumer, registration, config });
    return () => {
      if (this.#subscribers.get(consumer) !== sub) return;
      this.#subscribers.delete(consumer);
      for (const [id, s] of this.#sessions) if (s.status === 'active') this.#enqueue(id, { kind: 'disarm', consumer, registration });
    };
  }
  barrier(id: string): Promise<boolean> {
    const s = this.#sessions.get(id);
    if (!s || s.status === 'degraded' || s.status === 'terminated') return Promise.resolve(false);
    if (s.status === 'active') this.#enqueue(id, { kind: 'flush' });
    if (s.accepted >= s.seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const pending = this.#barriers.get(id) ?? [];
      pending.push({ seq: s.seq, resolve }); this.#barriers.set(id, pending);
    });
  }
  terminate(id: string): void {
    const s = this.#sessions.get(id); if (!s) return;
    s.status = 'terminated'; this.#enqueue(id, { kind: 'terminate' });
  }
  exit(id: string): void {
    const s = this.#sessions.get(id); if (!s) return;
    if (s.status === 'sealed' || s.status === 'terminated') return;
    if (s.status === 'active') s.status = 'sealed';
    this.#enqueue(id, { kind: 'exit' });
    // Finite immutable tombstones, never retain dead PTY authority.
    if (this.#sessions.size > 256) for (const [old, entry] of this.#sessions) {
      if (old !== id && entry.status !== 'active' && entry.queue.length === 0 && this.#flight?.sessionId !== old) {
        this.#discard(old, entry); this.#sessions.delete(old); break;
      }
    }
  }
  accept(value: unknown): boolean {
    if (!validAnalysisResult(value) || value.workerEpoch !== this.#epoch) return false;
    const r = value;
    const s = this.#sessions.get(r.sessionId);
    if (!s || s.generation !== r.generation || r.eventSeq < s.accepted || r.eventSeq > s.seq) return false;
    const flight = this.#flight;
    const ack = r.done !== false && flight && flight.workerEpoch === r.workerEpoch && flight.sessionId === r.sessionId &&
      flight.generation === r.generation && flight.eventSeq === r.eventSeq;
    // Timer notifications may share the accepted through-sequence but never
    // release bytes or advance the FIFO. Only the exact submitted job does.
    if (!ack && r.ackBytes !== 0) return false;
    if (ack) {
      const bytes = flight.kind === 'data' ? Buffer.byteLength(flight.data) : 0;
      if (r.ackBytes !== bytes) return false;
      this.#flight = null; s.bytes -= bytes; this.#bytes -= bytes; this.#acked += bytes; s.totalAcked += bytes;
      this.deps.acknowledged?.(r.sessionId, bytes);
      if (s.bytes < ANALYSIS_SESSION_BYTES / 2 && s.status === 'active') this.#pause(r.sessionId, s, false);
    }
    s.accepted = Math.max(s.accepted, r.eventSeq);
    if (s.status !== 'degraded' && s.status !== 'terminated') {
      if (r.screenText !== undefined) s.text = r.screenText;
      for (const event of r.events) this.#apply(r, s, event);
    }
    const pending = this.#barriers.get(r.sessionId);
    if (pending) {
      const remaining = pending.filter((b) => { if (b.seq > s.accepted) return true; b.resolve(s.status !== 'degraded' && s.status !== 'terminated'); return false; });
      if (remaining.length) this.#barriers.set(r.sessionId, remaining); else this.#barriers.delete(r.sessionId);
    }
    this.#pump(); return true;
  }
  fail(reason: string): void {
    this.#epoch++; this.#flight = null; this.#degraded = true;
    for (const [id, s] of this.#sessions) {
      s.status = 'degraded';
      // Explicit loss of analysis; release flow control so poison cannot stop
      // the authoritative PTY host. Never replay poison or run Main fallback.
      this.deps.acknowledged?.(id, s.bytes); this.#discard(id, s); this.#pause(id, s, false);
    }
    this.deps.trace?.({ kind: 'pty-analysis-degraded', workerEpoch: this.#epoch, reason });
  }
  diagnostics() {
    const sessions = [...this.#sessions.entries()].sort(([, a], [, b]) => Number(b.status === 'active') - Number(a.status === 'active')).slice(0, 64)
      .map(([sessionId, s]) => ({ sessionId, status: s.status, pendingBytes: s.bytes, totalAdmittedBytes: s.totalAdmitted, totalAckedBytes: s.totalAcked }));
    return { metrics: this.metrics(), sessions };
  }
  recoverFreshSessions(): void { this.#degraded = false; }
  metrics() { return { degradedSessions: [...this.#sessions.values()].filter((s) => s.status === 'degraded').length, workerEpoch: this.#epoch, pendingBytes: this.#bytes, inFlight: this.#flight !== null,
    admittedBytes: this.#admitted, ackedBytes: this.#acked, highwaterBytes: this.#highwater, sessions: this.#sessions.size, degraded: this.#degraded }; }
  #apply(r: AnalysisResult, s: Session, e: AnalysisEvent) {
    if (e.consumer !== 'failover' || ((e.value as { scanned?: boolean }).scanned || (e.value as { unavailable?: boolean }).unavailable)) s.latest.set(e.consumer, { value: e.value, fence: { workerEpoch: r.workerEpoch, sessionId: r.sessionId, generation: r.generation, eventSeq: r.eventSeq, observedAt: r.observedAt } });
    if (e.archival && (e.consumer === 'handoff' || e.consumer === 'completion')) {
      const items = s.evidence.get(e.consumer) ?? []; items.push(e.value); if (items.length > 4) items.shift(); s.evidence.set(e.consumer, items);
    }
    const sub = this.#subscribers.get(e.consumer);
    if (sub && sub.registration === e.registration && (s.status === 'active' || (s.status === 'sealed' && e.archival))) {
      try { sub.callback(r.sessionId, e.value, r); } catch { this.deps.trace?.({ kind: 'pty-analysis-consumer-error', consumer: e.consumer, error: 'callback-failed' }); }
    }
  }
  #pause(id: string, s: Session, paused: boolean) { if (s.paused !== paused) { s.paused = paused; this.deps.flow(id, paused); } }
  #discard(id: string, s: Session) {
    if (this.#flight?.sessionId === id && this.#flight.generation === s.generation) this.#flight = null;
    this.#bytes -= s.bytes; s.bytes = 0; s.queue = [];
    for (const b of this.#barriers.get(id) ?? []) b.resolve(false); this.#barriers.delete(id);
  }
  #enqueue(id: string, body: InputBody) {
    const s = this.#sessions.get(id); if (!s || this.#degraded || s.status === 'degraded') return;
    const record = { ...body, workerEpoch: this.#epoch, sessionId: id, generation: s.generation,
      eventSeq: ++s.seq, observedAt: this.deps.now() } as AnalysisInput;
    if (record.kind === 'data') s.lastDataSeq = record.eventSeq;
    const previous = s.queue.at(-1);
    if (record.kind === 'data' && previous?.kind === 'data' && record.endOfChunk !== false && previous.endOfChunk !== false &&
        previous.data.length + record.data.length <= ANALYSIS_UNIT_BYTES / 3 && (previous.pieces?.length ?? 1) < 512) {
      const pieces = [...(previous.pieces ?? [{ chars: previous.data.length, at: previous.observedAt }]), { chars: record.data.length, at: record.observedAt }];
      s.queue[s.queue.length - 1] = { ...record, data: previous.data + record.data, pieces };
    } else s.queue.push(record);
    this.#pump();
  }
  #pump() {
    if (this.#flight || this.#degraded) return;
    const ids = [...this.#sessions.keys()];
    const start = (ids.indexOf(this.#lastSession) + 1) % Math.max(1, ids.length);
    for (let offset = 0; offset < ids.length; offset++) {
      const id = ids[(start + offset) % ids.length];
      const s = this.#sessions.get(id)!;
      const record = s.queue.shift(); if (!record) continue;
      this.#lastSession = id; this.#flight = record;
      try { this.deps.post(record); } catch { this.fail('post-failed'); }
      return;
    }
  }
}
