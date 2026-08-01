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
//   frames were dropped, never reordered.
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
 * without a bound the per-session map is a slow leak. The least-recently-
 * published session is evicted (its ring AND its seq counter — a session
 * revived after eviction restarts at seq 1, acceptable for long-dead PTYs).
 */
export const OBSERVER_MAX_SESSIONS = 512;

interface SessionRing {
  nextSeq: number;
  frames: ObserverFrame[];
}

/**
 * Map iteration order is insertion order; re-inserting on every publish keeps
 * the first key = least-recently-published session (cheap LRU).
 */
const ringsBySession = new Map<string, SessionRing>();

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
      ring = { nextSeq: 1, frames: [] };
    }
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
    const coldest = ringsBySession.keys().next().value;
    if (coldest === undefined || coldest === protectedSessionId) return;
    ringsBySession.delete(coldest);
  }
}

/** Test-only: drop all rings, seq counters and taps. */
export function __resetObserverBusForTests(): void {
  ringsBySession.clear();
  frameTaps.clear();
}
