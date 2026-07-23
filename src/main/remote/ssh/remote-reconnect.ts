// Terminal stream reconnect/resume helpers (Gap D6 lean).
// Uses terminal-stream seq numbers; pure and testable.
// Copyright (c) 2026 Lovecast Inc. — MIT License (Nexus-authored; ORCA stream concepts @ 143c36e).
// See third_party/licenses/orca-MIT.txt.

/**
 * Explicit resume result. A partial replay is never returned as if it were
 * lossless: any invalid cursor, eviction, or internal gap requires a snapshot.
 */
export type TerminalResumeResult =
  | {
      readonly snapshotRequired: false;
      readonly frames: readonly Uint8Array[];
      readonly fromSeq: number;
      readonly toSeq: number;
    }
  | {
      readonly snapshotRequired: true;
      readonly frames: readonly [];
      readonly oldestAvailableSeq: number | null;
      readonly latestSeq: number;
    };

export function resolveTerminalResume(
  buffered: ReadonlyMap<number, Uint8Array>,
  clientLastSeq: number,
  latestSeq: number,
): TerminalResumeResult {
  const normalizedLatest = Math.max(0, Math.floor(latestSeq));
  if (
    !Number.isFinite(clientLastSeq)
    || clientLastSeq < 0
    || Math.floor(clientLastSeq) !== clientLastSeq
    || clientLastSeq > normalizedLatest
  ) {
    return snapshotRequired(buffered, normalizedLatest);
  }
  if (clientLastSeq === normalizedLatest) {
    return {
      snapshotRequired: false,
      frames: [],
      fromSeq: normalizedLatest + 1,
      toSeq: normalizedLatest,
    };
  }

  const oldest = oldestBufferedSeq(buffered);
  if (oldest === null || clientLastSeq < oldest - 1) {
    return snapshotRequired(buffered, normalizedLatest);
  }

  const frames: Uint8Array[] = [];
  for (let seq = clientLastSeq + 1; seq <= normalizedLatest; seq += 1) {
    const frame = buffered.get(seq);
    if (!frame) {
      return snapshotRequired(buffered, normalizedLatest);
    }
    frames.push(frame);
  }
  return {
    snapshotRequired: false,
    frames,
    fromSeq: clientLastSeq + 1,
    toSeq: normalizedLatest,
  };
}

/**
 * Legacy frame-only helper retained for callers that do not need the reason.
 * New production code must use resolveTerminalResume so snapshotRequired is
 * never collapsed into an ambiguous empty replay.
 */
export function framesToResume(
  buffered: ReadonlyMap<number, Uint8Array>,
  clientLastSeq: number,
): Uint8Array[] {
  if (!Number.isFinite(clientLastSeq) || clientLastSeq < 0) return [];
  const frames: Uint8Array[] = [];
  let nextSeq = Math.floor(clientLastSeq) + 1;
  while (buffered.has(nextSeq)) {
    frames.push(buffered.get(nextSeq)!);
    nextSeq += 1;
  }
  return frames;
}

export function shouldFullSnapshot(clientLastSeq: number, serverOldestSeq: number): boolean {
  if (!Number.isFinite(clientLastSeq) || clientLastSeq < 0) return true;
  return clientLastSeq < serverOldestSeq - 1;
}

function snapshotRequired(
  buffered: ReadonlyMap<number, Uint8Array>,
  latestSeq: number,
): TerminalResumeResult {
  return {
    snapshotRequired: true,
    frames: [],
    oldestAvailableSeq: oldestBufferedSeq(buffered),
    latestSeq,
  };
}

function oldestBufferedSeq(
  buffered: ReadonlyMap<number, Uint8Array>,
): number | null {
  let oldest: number | null = null;
  for (const seq of buffered.keys()) {
    if (oldest === null || seq < oldest) oldest = seq;
  }
  return oldest;
}
