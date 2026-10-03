import { handoffStatusSchema, type HandoffStatus } from '../../shared/orch-types';

/**
 * Legacy handoff parsing: agents that predate the MCP tool print a
 * `### NEXUS_HANDOFF v1` block followed by a JSON object into their terminal.
 * This streaming parser watches per-session output for that marker and
 * extracts {status, summary, artifacts} as a fallback path into the handoff
 * store. Input must already be ANSI-stripped.
 */

export const LEGACY_MARKER = '### NEXUS_HANDOFF v1';

/**
 * Some terminal-native providers normalize a Markdown heading by one level
 * when rendering their final answer (field case: AGY emitted `##` although
 * the sealed prompt contained `###`). TUIs also reprint the contract as
 * bare `NEXUS_HANDOFF` / `NEXUS_HANDOFF v1` with no hashes (Overclock Stop-hook
 * and the pane-3 AGY field case). The marker is only a framing token: the
 * Main still derives mission/session/incarnation from the physical PTY tap.
 * Case-folded sentinels stay rejected so random prose cannot promote.
 */
const LEGACY_MARKER_VARIANTS = Object.freeze([
  LEGACY_MARKER,
  '## NEXUS_HANDOFF v1',
  '#### NEXUS_HANDOFF v1',
  '# NEXUS_HANDOFF v1',
  '### NEXUS_HANDOFF',
  '## NEXUS_HANDOFF',
  '#### NEXUS_HANDOFF',
  '# NEXUS_HANDOFF',
  'NEXUS_HANDOFF v1',
  'NEXUS_HANDOFF',
]);

const MAX_BLOCK_CHARS = 16_384;
const TAIL_KEEP =
  Math.max(...LEGACY_MARKER_VARIANTS.map((marker) => marker.length)) - 1;
/** O núcleo comum a toda variante. */
const MARKER_CORE = 'NEXUS_HANDOFF';
/** Prefixo mais longo entre as variantes: `#### `. */
const MAX_MARKER_HASHES = 4;

/**
 * A variante mais à esquerda — e, no empate, a mais longa — numa passada só
 * (F-764 C.3). Antes eram dez `indexOf` sobre o texto inteiro, refeitos depois
 * de cada bloco: um texto com muitos marcadores ficava quadrático (16 KB:
 * 14 ms; 64 KB estourava a pilha pela recursão de `feed`).
 *
 * Equivalência: toda variante é `[#{1,4} ]NEXUS_HANDOFF[ v1]`. Ocorrências do
 * núcleo não se sobrepõem (distam ≥ 13) e o prefixo tem no máximo 5
 * caracteres, então a variante que começa mais cedo vem da PRIMEIRA
 * ocorrência do núcleo, com o maior prefixo `#…# ` encostado nela (até 4 `#`)
 * e o ` v1` quando ele vem logo depois.
 */
export function findLegacyMarker(text: string): {
  index: number;
  length: number;
} | null {
  const core = text.indexOf(MARKER_CORE);
  if (core === -1) return null;
  let index = core;
  if (core >= 2 && text[core - 1] === ' ') {
    let hashes = 0;
    while (
      hashes < MAX_MARKER_HASHES &&
      core - 2 - hashes >= 0 &&
      text[core - 2 - hashes] === '#'
    ) {
      hashes += 1;
    }
    if (hashes > 0) index = core - 1 - hashes;
  }
  let length = core - index + MARKER_CORE.length;
  if (text.startsWith(' v1', core + MARKER_CORE.length)) length += 3;
  return { index, length };
}

export interface LegacyHandoffPayload {
  status: HandoffStatus;
  summary: string;
  artifacts: unknown[];
}

/**
 * Terminal transports hard-wrap long lines at the pane width: the TUI emits
 * CR/LF plus the transcript indent in the MIDDLE of the block text. Inside a
 * JSON string literal that raw newline makes the candidate unparseable, so a
 * real handoff with a realistic summary never completed (field case: AGY/gemini
 * TUI wrapped `"summary":"...visíveis␍␊  encontradas."` and the block was
 * dropped while the placeholder example block — short enough to fit one line —
 * kept parsing). Repair joins a wrapped continuation with a single space, and
 * can only affect sequences that are invalid JSON anyway: raw CR/LF inside a
 * string literal. Newlines between JSON tokens (pretty-printed blocks) are
 * valid and untouched. Payload validation downstream is unchanged.
 */
export function repairTerminalLineWrap(candidate: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const ch = candidate[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        // Hard-wrap: consume the newline run and the continuation indent.
        let end = index;
        while (
          end < candidate.length &&
          (candidate[end] === '\n' ||
            candidate[end] === '\r' ||
            candidate[end] === ' ' ||
            candidate[end] === '\t')
        ) {
          end += 1;
        }
        out += ' ';
        index = end - 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
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
        const candidate = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(candidate), end: i + 1 };
        } catch {
          try {
            return {
              value: JSON.parse(repairTerminalLineWrap(candidate)),
              end: i + 1,
            };
          } catch {
            return null;
          }
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
export const LEGACY_DEDUPE_TTL_MS = 60 * 60_000;

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

  /** Release a reservation after a transient Main-owned ingest failure. */
  forget(sessionId: string, payload: LegacyHandoffPayload): void {
    this.seen.delete(
      `${sessionId}\n${payload.status}\n${payload.summary}`,
    );
  }

  dropSession(sessionId: string): void {
    const prefix = `${sessionId}\n`;
    for (const key of this.seen.keys()) {
      if (key.startsWith(prefix)) this.seen.delete(key);
    }
  }
}

/**
 * Overclock vocabulary (`done`/`error`) mapped onto the Nexus contract at the
 * boundary. Shared by the PTY marker parser and the MCP tool handler so a
 * worker that copied Overclock muscle memory — or a doctrine that still
 * teaches the old enum — lands instead of bouncing off zod.
 */
export function normalizeHandoffStatusInput(raw: unknown): unknown {
  if (raw === 'done') return 'success';
  if (raw === 'error') return 'failed';
  return raw;
}

/**
 * F-764 C.3: pertença direta ao enum. O `safeParse` do zod custa ~40 µs por
 * FALHA (monta o erro), e a releitura do anel no idle pagava isso por bloco —
 * 256 KB de blocos vazios passavam de 300 ms. Mesmo veredito: o enum só aceita
 * estas strings.
 */
const HANDOFF_STATUSES: ReadonlySet<string> = new Set(handoffStatusSchema.options);

function normalizeObservedHandoffStatus(raw: unknown): HandoffStatus | null {
  const value = normalizeHandoffStatusInput(raw);
  return typeof value === 'string' && HANDOFF_STATUSES.has(value)
    ? (value as HandoffStatus)
    : null;
}

function toPayload(value: unknown): LegacyHandoffPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const status = normalizeObservedHandoffStatus(obj.status);
  const summary = typeof obj.summary === 'string' ? obj.summary : null;
  if (!status || !summary) return null;
  return {
    status,
    summary,
    artifacts: Array.isArray(obj.artifacts) ? obj.artifacts : [],
  };
}

/**
 * Scan a complete (already ANSI-stripped) PTY snapshot for every completed
 * legacy block. Used when the live chunk parser missed a TUI repaint: idle
 * and exit promotion re-read the ring buffer the same way Overclock's
 * Stop-hook re-reads the last assistant turn.
 */
export function extractLegacyHandoffsFromText(
  text: string,
): LegacyHandoffPayload[] {
  if (!text.includes('NEXUS_HANDOFF')) return [];
  const received: LegacyHandoffPayload[] = [];
  const parser = new LegacyHandoffParser((_sessionId, payload) => {
    received.push(payload);
  });
  parser.feed('snapshot', text);
  return received;
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
    // Laço, não recursão (F-764 C.3): cada bloco extraído devolvia o resto a
    // `feed`, e um texto com milhares de blocos estourava a pilha.
    let input = chunk;
    for (;;) {
      if (this.collecting.has(sessionId)) {
        const body = (this.collecting.get(sessionId) ?? '') + input;
        const extracted = extractJsonObject(body);
        if (!extracted) {
          if (body.length > MAX_BLOCK_CHARS) {
            // Malformed/unterminated block — abandon rather than buffer forever.
            this.collecting.delete(sessionId);
          } else {
            this.collecting.set(sessionId, body);
          }
          return;
        }
        this.collecting.delete(sessionId);
        const payload = toPayload(extracted.value);
        if (payload) this.onHandoff(sessionId, payload);
        // Re-scan the remainder for another marker.
        input = body.slice(extracted.end);
        continue;
      }
      const buffered = (this.pending.get(sessionId) ?? '') + input;
      const marker = findLegacyMarker(buffered);
      if (!marker) {
        // Keep only enough tail to detect a marker that spans two chunks.
        this.pending.set(sessionId, buffered.slice(-TAIL_KEEP));
        return;
      }
      this.pending.delete(sessionId);
      this.collecting.set(sessionId, '');
      input = buffered.slice(marker.index + marker.length);
    }
  }

  dropSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.collecting.delete(sessionId);
  }
}
