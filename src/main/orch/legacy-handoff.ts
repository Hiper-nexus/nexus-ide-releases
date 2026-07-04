import { handoffStatusSchema, type HandoffStatus } from '../../shared/orch-types';

/**
 * Legacy handoff parsing: agents that predate the MCP tool print a
 * `### NEXUS_HANDOFF v1` block followed by a JSON object into their terminal.
 * This streaming parser watches per-session output for that marker and
 * extracts {status, summary, artifacts} as a fallback path into the handoff
 * store. Input must already be ANSI-stripped.
 */

export const LEGACY_MARKER = '### NEXUS_HANDOFF v1';

const MAX_BLOCK_CHARS = 16_384;
const TAIL_KEEP = LEGACY_MARKER.length - 1;

export interface LegacyHandoffPayload {
  status: HandoffStatus;
  summary: string;
  artifacts: unknown[];
}

/**
 * Extract the first balanced top-level JSON object from `text`. Returns the
 * parsed value and the index just past it, or null while incomplete.
 */
export function extractJsonObject(
  text: string,
): { value: unknown; end: number } | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toPayload(value: unknown): LegacyHandoffPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const status = handoffStatusSchema.safeParse(obj.status);
  const summary = typeof obj.summary === 'string' ? obj.summary : null;
  if (!status.success || !summary) return null;
  return {
    status: status.data,
    summary,
    artifacts: Array.isArray(obj.artifacts) ? obj.artifacts : [],
  };
}

/**
 * Streaming parser: feed() chunks per session; emits at most one payload per
 * marker occurrence via the callback passed to the constructor.
 */
export class LegacyHandoffParser {
  private pending = new Map<string, string>(); // sessionId → buffered text
  private collecting = new Map<string, string>(); // sessionId → block body

  constructor(
    private readonly onHandoff: (
      sessionId: string,
      payload: LegacyHandoffPayload,
    ) => void,
  ) {}

  feed(sessionId: string, chunk: string): void {
    if (this.collecting.has(sessionId)) {
      this.collect(sessionId, chunk);
      return;
    }
    const buffered = (this.pending.get(sessionId) ?? '') + chunk;
    const markerIndex = buffered.indexOf(LEGACY_MARKER);
    if (markerIndex === -1) {
      // Keep only enough tail to detect a marker that spans two chunks.
      this.pending.set(sessionId, buffered.slice(-TAIL_KEEP));
      return;
    }
    this.pending.delete(sessionId);
    this.collecting.set(sessionId, '');
    this.collect(sessionId, buffered.slice(markerIndex + LEGACY_MARKER.length));
  }

  private collect(sessionId: string, chunk: string): void {
    const body = (this.collecting.get(sessionId) ?? '') + chunk;
    const extracted = extractJsonObject(body);
    if (extracted) {
      this.collecting.delete(sessionId);
      const payload = toPayload(extracted.value);
      if (payload) this.onHandoff(sessionId, payload);
      // Re-scan the remainder for another marker.
      this.feed(sessionId, body.slice(extracted.end));
      return;
    }
    if (body.length > MAX_BLOCK_CHARS) {
      // Malformed/unterminated block — abandon rather than buffer forever.
      this.collecting.delete(sessionId);
      return;
    }
    this.collecting.set(sessionId, body);
  }

  dropSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.collecting.delete(sessionId);
  }
}
