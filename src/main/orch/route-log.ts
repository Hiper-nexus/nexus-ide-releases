/**
 * Route decision log — a short, inspectable history of what the router chose
 * and WHY, so a mission's adapter selection stops being invisible. Pure logic
 * (no electron/sqlite): the MCP handler records each nexus_route_task result
 * here; a debug/inspect surface (and the orchestration panel) can read it back.
 *
 * "Ver para crer" (Onda 1): before this, the reason existed only in the
 * router's return value the LLM consumed — the user could never see why Kimi
 * lost to Codex. Now the last N decisions are queryable with their tier,
 * pick, effort and human-readable reason.
 */

export interface RouteLogEntry {
  /** Monotonic ordinal (no Date in pure logic); higher = newer. */
  seq: number;
  taskPreview: string;
  tier: string;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
}

export interface RouteLogInput {
  task: string;
  tier: string;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
}

const LOG_CAP = 50;
const TASK_PREVIEW_CHARS = 120;

let log: RouteLogEntry[] = [];
let seq = 0;

export function clearRouteLog(): void {
  log = [];
  seq = 0;
}

export function recordRouteLog(input: RouteLogInput): RouteLogEntry {
  seq += 1;
  const entry: RouteLogEntry = {
    seq,
    taskPreview: input.task.slice(0, TASK_PREVIEW_CHARS),
    tier: input.tier,
    adapterId: input.adapterId,
    model: input.model,
    effort: input.effort,
    reason: input.reason,
  };
  log = [...log.slice(-(LOG_CAP - 1)), entry];
  return entry;
}

/** Most-recent-first snapshot, capped at `limit` (default all retained). */
export function recentRouteLog(limit = LOG_CAP): RouteLogEntry[] {
  return [...log].reverse().slice(0, Math.max(0, limit));
}
