// In-process observer bus — increment 1 of the Nexus observability plane.
// Design distilled from block/buzz NIP-AO / buzz-acp observer.rs (Apache-2.0).
//
// Intentionally process-local infrastructure (buzz observer.rs keeps the same
// stance): main-process emitters publish typed ObserverFrames, consumers
// subscribe live (tap) or read the bounded replay buffer (snapshot). The
// mission-event projector is the durable consumer; detector consumption stays
// additive and can be introduced without changing the emitter contract.
//
// Contract:
// - Ring buffer of OBSERVER_RING_CAP frames PER SESSION; the oldest frame is
//   discarded first (NIP-AO: "clients SHOULD buffer received events in a
//   bounded in-memory ring buffer").
// - `seq` is monotonic per session starting at 1 (single-threaded main
//   process — the increment is trivially atomic). A gap at a consumer means
//   frames were dropped, never reordered. Monotonicity outlives the ring: a
//   session whose ring was evicted keeps a seq tombstone, so reviving it
//   continues the count instead of replaying seq 1 (a backwards seq would
//   look like a different session, not like a drop).
// - Total function: publishing NEVER throws. The bus is an additive
//   observability plane — a bus failure must never break the emitter (the
//   hook gate endpoint above all).

import type {
  ObserverFrame,
  ObserverFrameInput,
} from '../../shared/observer-frame';

/** Max frames retained per session before the oldest is discarded. */
export const OBSERVER_RING_CAP = 1000;
/**
 * Max sessions with a live ring. Long-running apps spawn workers for days;
 * without a bound the per-session map is a slow leak. Eviction drops the
 * REPLAY BUFFER, never the seq contract: the victim is the coldest session
 * that already framed `session_exited` (a death is the only honest signal
 * that a session is done talking) and only when no dead session is available
 * does the least-recently-published live session go — a live session can be
 * silent for hours and still be doing work.
 */
export const OBSERVER_MAX_SESSIONS = 512;

/**
 * Max seq tombstones kept for evicted sessions. A tombstone is one string key
 * + one number, three orders of magnitude cheaper than the ring it replaces,
 * so the bound can be generous; past it the oldest tombstone drops (that
 * session would restart at 1, the pre-tombstone behaviour).
 */
export const OBSERVER_MAX_SEQ_TOMBSTONES = 4096;

interface SessionRing {
  nextSeq: number;
  /** True while the last frame published for this session was its death. */
  ended: boolean;
  frames: ObserverFrame[];
}

/**
 * Map iteration order is insertion order; re-inserting on every publish keeps
 * the first key = least-recently-published session (cheap LRU).
 */
const ringsBySession = new Map<string, SessionRing>();

/**
 * seq counter of sessions whose ring was evicted, so a revived session picks
 * the count back up. Insertion order = LRU, same as the ring map.
 */
const seqTombstones = new Map<string, number>();

export type ObserverFrameTap = (frame: ObserverFrame) => void;
const frameTaps = new Set<ObserverFrameTap>();

/** Subscribe to every published frame (all sessions). Returns unsubscribe. */
export function tapObserverFrames(tap: ObserverFrameTap): () => void {
  frameTaps.add(tap);
  return () => frameTaps.delete(tap);
}

/** Bounded replay buffer for one session, oldest first. Always a fresh copy. */
export function snapshotObserverFrames(sessionId: string): ObserverFrame[] {
  const ring = ringsBySession.get(sessionId);
  return ring ? [...ring.frames] : [];
}

/**
 * The ObserverFrameInput mapped type guarantees kind↔payload correlation is
 * intact; re-attaching the bus-assigned fields cannot produce an invalid
 * union member, so the single assertion below is safe (and the only one).
 */
function sealFrame(input: ObserverFrameInput, seq: number, at: number): ObserverFrame {
  // Current payloads are flat typed records. Freezing both layers keeps a live
  // tap from mutating the frame retained by the replay ring or seen by a later
  // consumer. The input itself is never mutated.
  const frame = {
    ...input,
    payload: Object.freeze({ ...input.payload }),
    seq,
    at,
  } as ObserverFrame;
  return Object.freeze(frame);
}

/**
 * Publish one frame: assign the per-session seq, store it in the session
 * ring (discarding the oldest past OBSERVER_RING_CAP) and fan out to taps.
 * Total function — returns the sealed frame, or null when the frame was
 * dropped (no sessionId / internal failure). Never throws; a throwing tap is
 * contained per-tap and cannot starve other taps or the ring write.
 */
export function publishObserverFrame(input: ObserverFrameInput): ObserverFrame | null {
  try {
    if (!input.sessionId) return null;

    let ring = ringsBySession.get(input.sessionId);
    if (ring) {
      // Re-insert to mark this session most-recently-published.
      ringsBySession.delete(input.sessionId);
    } else {
      ring = { nextSeq: reclaimSeq(input.sessionId), ended: false, frames: [] };
    }
    // A session that frames again after its death is alive again (resumed pane
    // on the same physical id) and stops being a preferred eviction victim.
    ring.ended = input.kind === 'session_exited';
    ringsBySession.set(input.sessionId, ring);
    evictColdestSessions(input.sessionId);

    const frame = sealFrame(input, ring.nextSeq, input.at ?? Date.now());
    ring.nextSeq += 1;
    ring.frames.push(frame);
    if (ring.frames.length > OBSERVER_RING_CAP) {
      ring.frames.shift();
    }

    for (const tap of frameTaps) {
      try {
        tap(frame);
      } catch (err) {
        console.warn('[observer-bus] frame tap threw (contained):', err);
      }
    }
    return frame;
  } catch (err) {
    console.warn('[observer-bus] publish failed (frame dropped):', err);
    return null;
  }
}

function evictColdestSessions(protectedSessionId: string): void {
  while (ringsBySession.size > OBSERVER_MAX_SESSIONS) {
    const victim = pickEvictionVictim(protectedSessionId);
    if (victim === null) return;
    rememberSeq(victim);
    ringsBySession.delete(victim);
  }
}

/**
 * Coldest ENDED session first (its replay buffer can never grow again);
 * otherwise the coldest live session. Map iteration is insertion order, so
 * the first match in each class is the least-recently-published one.
 */
function pickEvictionVictim(protectedSessionId: string): string | null {
  let coldestLive: string | null = null;
  for (const [sessionId, ring] of ringsBySession) {
    if (sessionId === protectedSessionId) continue;
    if (ring.ended) return sessionId;
    if (coldestLive === null) coldestLive = sessionId;
  }
  return coldestLive;
}

/** Keep the evicted session's seq so a revival never replays seq 1. */
function rememberSeq(sessionId: string): void {
  const ring = ringsBySession.get(sessionId);
  if (!ring) return;
  seqTombstones.delete(sessionId);
  seqTombstones.set(sessionId, ring.nextSeq);
  while (seqTombstones.size > OBSERVER_MAX_SEQ_TOMBSTONES) {
    const oldest = seqTombstones.keys().next().value;
    if (oldest === undefined) return;
    seqTombstones.delete(oldest);
  }
}

/** seq a (re)created ring starts from: the tombstone, or 1 for a new session. */
function reclaimSeq(sessionId: string): number {
  const kept = seqTombstones.get(sessionId);
  if (kept === undefined) return 1;
  seqTombstones.delete(sessionId);
  return kept;
}

/** Test-only: drop all rings, seq counters, tombstones and taps. */
export function __resetObserverBusForTests(): void {
  ringsBySession.clear();
  seqTombstones.clear();
  frameTaps.clear();
}
