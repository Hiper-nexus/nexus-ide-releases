/**
 * "Citar resposta" (WEB-17): um item da atividade da missão vira um trecho
 * citado na orientação, com uma referência de origem que não depende da
 * posição na tela. A âncora é o evento do journal — `missionId` + `eventId`
 * (estáveis no journal append-only) + `sequence` — e, quando o evento veio de
 * um terminal, o `paneId`. Índices de lista, filtro e virtualização nunca
 * entram na referência: a mesma citação aponta o mesmo evento amanhã.
 */

export interface QuoteOrigin {
  readonly missionId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly runId?: string;
  readonly paneId?: string;
  /** Nome do agente dono do pane, quando o Quadro o conhece. */
  readonly agentName?: string;
}

/** Citação pronta para entrar no composer; `nonce` distingue duas iguais. */
export interface QuoteDraft {
  readonly origin: QuoteOrigin;
  readonly text: string;
  readonly nonce: number;
}

/** Teto do trecho citado: a orientação aceita 16 KiB e é texto do operador. */
export const QUOTE_EXCERPT_MAX_CHARS = 1_200;
export const QUOTE_EXCERPT_MAX_LINES = 24;

const ORIGIN_TAG_RE = /\[origem: missao=([^\s\]]+) evento=([^\s\]]+) seq=(\d+)(?: pane=([^\s\]]+))?\]/gu;

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Marca de origem legível e analisável: `[origem: missao=… evento=… seq=… pane=…]`. */
export function quoteOriginTag(origin: QuoteOrigin): string {
  const pane = origin.paneId ? ` pane=${encode(origin.paneId)}` : '';
  return `[origem: missao=${encode(origin.missionId)} evento=${encode(origin.eventId)} seq=${origin.sequence}${pane}]`;
}

/** Lê de volta as origens citadas num texto (orientação enviada, rascunho). */
export function parseQuoteOrigins(
  text: string,
): Array<Pick<QuoteOrigin, 'missionId' | 'eventId' | 'sequence' | 'paneId'>> {
  const found: Array<Pick<QuoteOrigin, 'missionId' | 'eventId' | 'sequence' | 'paneId'>> = [];
  for (const match of text.matchAll(ORIGIN_TAG_RE)) {
    found.push({
      missionId: decode(match[1]!),
      eventId: decode(match[2]!),
      sequence: Number(match[3]),
      ...(match[4] ? { paneId: decode(match[4]) } : {}),
    });
  }
  return found;
}

/** Trecho limitado em linhas e caracteres, sem linhas vazias nas pontas. */
export function quoteExcerpt(raw: string): string {
  const lines = raw.replace(/\r\n?/gu, '\n').trim().split('\n');
  let excerpt = lines.slice(0, QUOTE_EXCERPT_MAX_LINES).join('\n');
  let cut = lines.length > QUOTE_EXCERPT_MAX_LINES;
  if (excerpt.length > QUOTE_EXCERPT_MAX_CHARS) {
    excerpt = excerpt.slice(0, QUOTE_EXCERPT_MAX_CHARS).trimEnd();
    cut = true;
  }
  return cut ? `${excerpt}…` : excerpt;
}

/** Quem falou, em linguagem de operador. */
export function quoteSpeaker(origin: QuoteOrigin): string {
  if (origin.agentName) return origin.agentName;
  if (origin.paneId) return `pane ${origin.paneId}`;
  return 'missão';
}

/**
 * Bloco citado em Markdown: cabeçalho com quem/qual evento, o trecho em `> `
 * e a marca de origem numa linha própria, fora da citação.
 */
export function formatQuote(origin: QuoteOrigin, label: string, raw: string): string {
  const header = `${quoteSpeaker(origin)} · evento #${origin.sequence} · ${label.trim() || 'atividade'}`;
  const body = quoteExcerpt(raw || label)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'));
  return [`> ${header}`, ...body, quoteOriginTag(origin)].join('\n');
}

/** Junta a citação ao rascunho sem colar no texto já escrito. */
export function appendQuote(draft: string, quote: string): string {
  const base = draft.replace(/\s+$/u, '');
  return base ? `${base}\n\n${quote}\n\n` : `${quote}\n\n`;
}
