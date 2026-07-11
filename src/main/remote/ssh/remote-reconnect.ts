// Terminal stream reconnect/resume helpers (Gap D6 lean).
// Uses terminal-stream seq numbers; pure and testable.
// Copyright (c) 2026 Lovecast Inc. — MIT License (Nexus-authored; ORCA stream concepts @ 143c36e).
// See third_party/licenses/orca-MIT.txt.

/**
 * Decide which frames to retransmit after client reconnect.
 * Client reports last contiguous seq received; server holds buffered frames
 * keyed by seq (caller manages buffer).
 */
export function framesToResume(
  buffered: ReadonlyMap<number, Uint8Array>,
  clientLastSeq: number,
): Uint8Array[] {
  if (!Number.isFinite(clientLastSeq) || clientLastSeq < 0) {
    return [];
  }
  const seqs = [...buffered.keys()].filter((s) => s > clientLastSeq).sort((a, b) => a - b);
  // Require contiguous sequence from clientLastSeq+1; stop at first gap.
  const out: Uint8Array[] = [];
  let expect = Math.floor(clientLastSeq) + 1;
  for (const s of seqs) {
    if (s !== expect) break;
    const frame = buffered.get(s);
    if (!frame) break;
    out.push(frame);
    expect += 1;
  }
  return out;
}

export function shouldFullSnapshot(clientLastSeq: number, serverOldestSeq: number): boolean {
  if (!Number.isFinite(clientLastSeq) || clientLastSeq < 0) return true;
  return clientLastSeq < serverOldestSeq - 1;
}
