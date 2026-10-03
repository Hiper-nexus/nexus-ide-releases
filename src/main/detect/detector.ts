// Agent screen-state detector — main-process service port of Herdr's
// manifest-driven pane classification (herdrdev/herdr, Apache-2.0; see
// THIRD_PARTY_NOTICES.md). For each PTY session running a known agent CLI it
// evaluates the bundled TOML manifest against a recent screen snapshot and
// publishes idle | working | blocked | unknown, feeding the semantic status
// reducer as a "screen" source (hook authority still wins — see
// src/main/orch/agent-status.ts applyScreenDetectionEvent).
//
// FIDELITY vs HERDR: Herdr reads a rendered terminal cell grid — logical
// lines after soft-wrap, with cursor-addressed redraws resolved in place.
// NexusIDE has no terminal emulator in the main process, so the snapshot is
// a rolling ANSI-stripped text tail of the PTY stream (screen-buffer.ts).
// Consequences:
//  - Physical-row wraps are not rejoined; line_regex rules that anchor on a
//    full rendered row can miss when the row wrapped mid-pattern.
//  - TUI repaints append a fresh frame instead of replacing the old one, so
//    the tail holds several stale frames above the newest one. Every bundled
//    region heuristic keys on the BOTTOM of the buffer (bottom_non_empty_*,
//    prompt box from the last borders, after_last_*) which keeps the newest
//    frame authoritative; `whole_recent` rules see extra stale history and
//    lean on their `not` gates to compensate.
//  - OSC title/progress never reach the stripped text; osc.ts extracts them
//    from the raw stream separately.
// These divergences are deliberate: the manifests are kept byte-identical to
// upstream so Herdr's evidence-based manifest workflow stays portable.
//
// Anti-flicker and scan-skip semantics port
// src/pane/agent_detection.rs: PendingIdleConfirmation holds a working→idle
// transition without visible idle evidence for up to 3 confirmations at
// 100ms (700ms cap), and idle sessions whose content did not change are not
// re-scanned.

import { getAgentSessionInfo } from '../pty/pty-manager';
import { applyScreenDetectionEvent } from '../orch/agent-status';
import { analysisClient, subscribePtyAnalysis } from '../pty/pty-analysis-runtime';
import type { DetectionExplain } from './evaluator';
import type { DetectionPublishState, ScreenDetectionRecord, ScreenDetectionTap } from './detector-core';
export * from './detector-core';

let active: { dispose: () => void; taps: Set<ScreenDetectionTap>; explains: Map<string, { generation: number; explain: DetectionExplain }>; states: Map<string, DetectionPublishState> } | null = null;
/** Production never evaluates a manifest in Main. Queries read accepted caches. */
export function startAgentScreenDetection(): () => void {
  if (active) return active.dispose;
  const taps = new Set<ScreenDetectionTap>();
  const explains = new Map<string, { generation: number; explain: DetectionExplain }>();
  const states = new Map<string, DetectionPublishState>();
  const untap = subscribePtyAnalysis('screen', (sessionId, value, fence) => {
    const { record, explain, state, adapterId } = value as { adapterId?: string; record?: ScreenDetectionRecord; explain: DetectionExplain | null; state: DetectionPublishState | null };
    const info = getAgentSessionInfo(sessionId);
    if (!info || info.adapterId !== (record?.adapterId ?? adapterId) || (record && info.paneId !== record.paneId)) return;
    if (explain) explains.set(sessionId, { generation: fence.generation, explain });
    if (state) states.set(sessionId, state);
    if (!record) return;
    applyScreenDetectionEvent({ sessionId, state: record.state, visibleIdle: record.visibleIdle,
      visibleBlocker: record.visibleBlocker, visibleWorking: record.visibleWorking, now: record.at });
    for (const tap of taps) { try { tap(record); } catch (error) { console.warn('[detect] detection tap failed:', error); } }
  });
  const dispose = () => { untap(); if (active?.taps === taps) active = null; };
  active = { dispose, taps, explains, states }; return dispose;
}
export function tapActiveScreenDetections(cb: ScreenDetectionTap): (() => void) | null {
  if (!active) return null;
  const taps = active.taps; taps.add(cb); return () => taps.delete(cb);
}
export function activeScreenText(sessionId: string, maxChars = 6_000): string | null {
  if (!active) return null; const text = analysisClient.text(sessionId); return text ? text.slice(-maxChars) : null;
}
export function getScreenDetectionExplain(sessionId: string): DetectionExplain | null { const cached = active?.explains.get(sessionId); return cached && cached.generation === analysisClient.generation(sessionId) ? cached.explain : null; }
export function __resetAgentScreenDetectionForTests(): void { active?.dispose(); active = null; }
