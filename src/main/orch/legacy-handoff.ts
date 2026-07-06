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

/**
 * O kickoff dos workers não-MCP contém o bloco-EXEMPLO literal do contrato
 * (com summary "<resumo objetivo do que fez>"). O TUI ecoa/repinta esse texto
 * no output e o parser o lia como handoff real — spam infinito de handoffs
 * fantasma no orquestrador. Mesma régua da tool MCP: placeholder/curto demais
 * não é entrega.
 */
export function isPlaceholderSummary(summary: string): boolean {
  const clean = summary.trim();
  return clean.length < 20 || /^<.*>$/.test(clean);
}

/**
 * Dedupe por repaint: TUIs redesenham o transcript inteiro (scroll, resize,
 * frame de spinner) e o MESMO bloco de handoff volta a ser parseado — cada
 * repaint virava outra entrega ao orquestrador. Um handoff idêntico (mesma
 * sessão + status + summary) dentro da janela é repaint, não reentrega.
 */
export const LEGACY_DEDUPE_TTL_MS = 10 * 60_000;

export class LegacyHandoffDedupe {
  private seen = new Map<string, number>(); // sessionId\nstatus\nsummary → at

  constructor(private nowFn: () => number = Date.now) {}

  /** true = duplicata recente (descartar); false = inédito (registra). */
  isDuplicate(sessionId: string, payload: LegacyHandoffPayload): boolean {
    const key = `${sessionId}\n${payload.status}\n${payload.summary}`;
    const now = this.nowFn();
    const last = this.seen.get(key);
    if (last !== undefined && now - last < LEGACY_DEDUPE_TTL_MS) return true;
    this.seen.set(key, now);
    if (this.seen.size > 512) {
      // Poda simples: derruba entradas expiradas quando o mapa cresce.
      for (const [k, at] of this.seen) {
        if (now - at >= LEGACY_DEDUPE_TTL_MS) this.seen.delete(k);
      }
    }
    return false;
  }

  dropSession(sessionId: string): void {
    const prefix = `${sessionId}\n`;
    for (const key of this.seen.keys()) {
      if (key.startsWith(prefix)) this.seen.delete(key);
    }
  }
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

  /** Está no meio de um bloco deste session? (gate do prefiltro barato) */
  isCollecting(sessionId: string): boolean {
    return this.collecting.has(sessionId);
  }

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
