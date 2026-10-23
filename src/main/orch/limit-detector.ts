/**
 * Detects, from a CLI's terminal output, that the current account hit a limit
 * and work can't continue on it. Input must be ANSI-stripped. Pure function —
 * unit tested. The failover engine feeds it a rolling window of recent output.
 */

import {
  backoffMsForReason,
  classifyRateLimitText,
  type ClassifiedReason,
} from '../../vendor/omp/rate-limit/classify';
import { parseRetryAfterMsFromText } from '../../vendor/omp/rate-limit/retry-after-text';
import { parseAnthropicModelId } from '../../vendor/omp/catalog/identity';
import {
  CODEX_CHATGPT_MODEL_REJECTION,
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';
import type { FailoverReasonKind } from '../../shared/account-types';
import { compileTextPatternPrefilter } from '../../shared/required-text-hints';
import {
  CLI_SELF_MANAGED_THROTTLE,
  LIMIT_SIGNAL_PATTERNS as PATTERNS,
  NEXUS_ACCOUNT_LIMIT_LINE,
  isLabeledHistoricalOutput,
} from '../../shared/limit-signal-patterns';

// F-999: a tabela de sinais e a neutralização de texto citado vivem em
// shared/ — o builder do pack de continuidade (Main e renderer) neutraliza
// com a mesma fonte. Reexportadas aqui para os chamadores do Main.
export { neutralizeLimitSignals, quotedLimitSignalPatterns } from '../../shared/limit-signal-patterns';
const candidatePatterns = compileTextPatternPrefilter(PATTERNS);

/**
 * - 'quota': conta/plano esgotado — cooldown longo, pinta a janela Semanal.
 * - 'rate-limit': janela rolante (5h) ou taxa por minuto — cooldown médio.
 * - 'auth': credencial expirada/inválida — trocar de conta pode recuperar.
 * - 'transient': blip do provedor (capacidade do modelo / 5xx) — cooldown de
 *   SEGUNDOS; não é janela de uso (a conta volta sozinha).
 */
export type LimitKind = FailoverReasonKind;

export interface LimitHit {
  kind: LimitKind;
  reason: string;
  /** Suggested cooldown in ms before this account is retried. */
  cooldownMs: number;
  /**
   * Escopo do bloqueio quando o erro menciona um modelo/tier específico
   * (`tier:opus`, `tier:sonnet`, …). Ausente = limite da conta inteira.
   * Um cooldown escopado NÃO tira a conta do pool para outros modelos.
   */
  scope?: string;
  /**
   * F-765: o erro só existe na saída desta CLI (a frase cita o próprio
   * produto). Em pane de outra CLI é texto citado, nunca sinal vivo.
   */
  adapterId?: string;
  /**
   * F-1410: confirmado pela POSIÇÃO — casou uma célula de status/erro que só a
   * TUI de `adapterId` desenha (padrão marcado na tabela compartilhada), não a
   * frase solta. O failover só o usa com `hit.adapterId === pane.adapterId`,
   * e só então marca a CLI sem conta gerenciada como limitada.
   * F-1484: também o limite que o PRÓPRIO provedor declarou estruturado
   * (StopFailure `rate_limit`), com `confirmedAt` = instante da declaração.
   */
  confirmed?: boolean;
  /**
   * F-1484: quando o provedor confirmou o limite (epoch ms). Só uma leitura de
   * cota feita DEPOIS disto pode refutá-lo; cache anterior nunca.
   */
  confirmedAt?: number;
}

// Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT):
// Claude escopa o bloco de credencial por tier do modelo (blockScope).
// Aqui a extração é textual (PTY): id completo via identity classifier,
// senão nome de família anthropic isolado perto do trecho que casou.

/** Janela de vizinhança (chars) ao redor do match para procurar o modelo. */
const TIER_NEAR_WINDOW = 160;

/** `claude-opus-4-6` → `tier:opus`; não-anthropic/idéia vaga → undefined. */
export function tierScopeFromModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const identity = parseAnthropicModelId(modelId);
  return identity ? `tier:${identity.kind}` : undefined;
}

/** Nome de família anthropic isolado (o erro raramente ecoa o id completo). */
const BARE_ANTHROPIC_FAMILY = /\b(opus|sonnet|haiku|fable|mythos)\b/i;
/** Id de modelo Claude completo dentro do texto de erro. */
const CLAUDE_MODEL_ID = /\bclaude-[a-z0-9][a-z0-9.-]*/i;

/**
 * Extrai `tier:<família>` do texto ao redor do trecho de erro que casou.
 * Só considera a vizinhança do match para não capturar prosa distante do
 * agente ("vou usar sonnet…") como escopo de um limite não relacionado.
 */
function extractAnthropicTierScope(
  text: string,
  matchIndex: number,
  matchLength: number,
): string | undefined {
  const start = Math.max(0, matchIndex - TIER_NEAR_WINDOW);
  const end = Math.min(text.length, matchIndex + matchLength + TIER_NEAR_WINDOW);
  return anthropicTierScope(text.slice(start, end));
}

/**
 * `tier:<família>` de um trecho que cita um modelo Claude (id completo ou
 * família solta: Opus, Sonnet, Haiku, Fable, Mythos). Fonte única da
 * taxonomia de tier — também usada no rótulo de janela por modelo
 * ("Semanal (Fable)", F-1484).
 */
export function anthropicTierScope(text: string): string | undefined {
  const fullId = CLAUDE_MODEL_ID.exec(text);
  if (fullId) {
    const scoped = tierScopeFromModelId(fullId[0]);
    if (scoped) return scoped;
  }
  const bare = BARE_ANTHROPIC_FAMILY.exec(text);
  return bare ? `tier:${bare[1].toLowerCase()}` : undefined;
}

const HOUR = 60 * 60 * 1000;

/**
 * Try to read an explicit reset time ("resets at 3pm", "try again in 42
 * minutes") to size the cooldown precisely; falls back to the pattern default.
 * O parser vendorado do omp cobre as variantes extras (hint `retry-after-ms=`,
 * headers ecoados no terminal, prosa "retry in 26.3s").
 */
/**
 * Claude/Codex in-process retry ticker ("Retrying in 1s · attempt 1/10").
 * That is NOT a provider reset time. Feeding it to cooldown turned a 401 into
 * a 1s same-account "recovery" that immediately 401'd again.
 */
const CLIENT_RETRY_TICKER =
  /\bretrying\s+in\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|secs?|seconds?|s)\s*[·|•\-]\s*attempt\s+\d+\s*\/\s*\d+/gi;

function stripClientRetryTicker(text: string): string {
  return text.replace(CLIENT_RETRY_TICKER, ' ');
}

function parseResetCooldown(text: string, now: number): number | null {
  const cleaned = stripClientRetryTicker(text);
  const mins = /try again in (\d+)\s*(?:minute|min)/i.exec(cleaned);
  if (mins) return Number(mins[1]) * 60 * 1000;
  const secs = /try again in (\d+)\s*(?:second|sec)/i.exec(cleaned);
  if (secs) return Number(secs[1]) * 1000;
  const hrs = /(?:resets?|available again) in (\d+)\s*hour/i.exec(cleaned);
  if (hrs) return Number(hrs[1]) * HOUR;
  const iso = parseResetIsoMs(cleaned, now);
  if (iso !== null) return iso;
  const clock = parseResetClockMs(cleaned, now);
  if (clock !== null) return clock;
  return parseRetryAfterMsFromText(cleaned, now);
}

/**
 * F-1410: reset em instante ISO-8601 absoluto — a API do Muse escreve "Your
 * usage window resets at 2026-10-12T21:55:00Z". Sem ambiguidade de fuso, então
 * vale até a janela semanal; passado (scrollback antigo) ou mais distante que
 * isso não é reset vivo e devolve null.
 */
const RESET_ISO_MAX_MS = 8 * 24 * HOUR;

function parseResetIsoMs(text: string, now: number): number | null {
  const m = /\bresets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (!m) return null;
  const at = Date.parse(m[1]);
  if (!Number.isFinite(at) || at <= now || at - now > RESET_ISO_MAX_MS) return null;
  return at - now;
}

/**
 * Reset em hora de parede: "resets 8:10pm (America/Sao_Paulo)" / "reset at
 * 3pm". A zona entre parênteses é a que a CLI Claude imprime; sem zona vale a
 * local. Só um horário FUTURO a até 6h conta — a janela rolante é de 5h, e um
 * horário mais distante (ou já passado, lido de scrollback antigo) não é
 * reset vivo: devolve null e o padrão fica com o cooldown default.
 */
const RESET_CLOCK_MAX_MS = 6 * HOUR;

function parseResetClockMs(text: string, now: number): number | null {
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]{1,64})\))?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const timeZone = m[4]?.trim();
  for (const dayOffset of [0, 1]) {
    const target = wallClockMs(now, dayOffset, hour, minute, timeZone);
    if (target === null) return null;
    if (target > now) return target - now <= RESET_CLOCK_MAX_MS ? target - now : null;
  }
  return null;
}

/** Componentes de parede na zona (ou local) → epoch ms; zona inválida = local. */
function wallClockMs(
  now: number,
  dayOffset: number,
  hour: number,
  minute: number,
  timeZone: string | undefined,
): number | null {
  if (!timeZone) {
    const local = new Date(now);
    return new Date(local.getFullYear(), local.getMonth(), local.getDate() + dayOffset, hour, minute).getTime();
  }
  try {
    const parts = (ms: number): Record<string, number> =>
      Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          hourCycle: 'h23',
          year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', second: 'numeric',
        })
          .formatToParts(new Date(ms))
          .map((part) => [part.type, Number(part.value)]),
      );
    const offsetAt = (ms: number): number => {
      const p = parts(ms);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
    };
    const today = parts(now);
    const naive = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute);
    // Duas passadas (DST): o offset certo é o do próprio instante-alvo.
    const first = naive - offsetAt(naive);
    return naive - offsetAt(first);
  } catch {
    return wallClockMs(now, dayOffset, hour, minute, undefined);
  }
}

/** Mapeia a taxonomia do omp para os kinds do Nexus. */
const KIND_BY_REASON: Record<ClassifiedReason, LimitKind> = {
  QUOTA_EXHAUSTED: 'quota',
  RATE_LIMIT_EXCEEDED: 'rate-limit',
  MODEL_CAPACITY_EXHAUSTED: 'transient',
  SERVER_ERROR: 'transient',
};

function cooldownForReason(reason: ClassifiedReason): number {
  // Quota mantém a janela LONGA do Nexus (esgotou a conta → rotaciona e
  // espera), não os 30min do omp — lá o valor era backoff de retry
  // in-process, aqui é quarentena de conta na frota.
  if (reason === 'QUOTA_EXHAUSTED') return 12 * HOUR;
  // Transitórios usam as durações CURTAS do omp (30s / 45s+jitter / 20s):
  // capacidade e 5xx se resolvem sozinhos; o cooldown longo de quota tiraria
  // a conta da frota sem motivo.
  return backoffMsForReason(reason);
}

/**
 * Excise Nexus's own failover continuity pack before matching.
 *
 * The pack is injected into the replacement pane's PTY and echoed back onto
 * stdout, where this detector re-scans it. It quotes the prior limit reason AND
 * a scrollback excerpt of the previous terminal — both carry verbatim provider
 * error text (framed `HTTP 401`, `payment required`, `429`, …) that survives any
 * per-token regex hardening. Left in place, every replacement account re-fires
 * failover and the whole fleet cascades into cooldown (the "Limite atingido"
 * loop, with accounts that still have quota showing 100% from `cooldown`).
 *
 * The pack is bounded by stable Nexus markers. Cut header → footer when the
 * footer has arrived; header → end while it is still streaming (suppress the
 * dangerous tail until it completes). Real provider output before the header or
 * after the footer is untouched and still triggers failover.
 */
function stripFailoverHandoffPack(text: string): string {
  let out = text;
  for (let guard = 0; guard < 8; guard += 1) {
    const start = out.indexOf(FAILOVER_HANDOFF_HEADER);
    if (start < 0) break;
    const footerAt = out.indexOf(
      FAILOVER_HANDOFF_FOOTER,
      start + FAILOVER_HANDOFF_HEADER.length,
    );
    if (footerAt < 0) {
      // Pack still streaming — drop from the header to the end of the buffer.
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(footerAt + FAILOVER_HANDOFF_FOOTER.length);
  }
  // F-511: packs antigos já persistidos ainda têm o motivo cru. A TUI pode
  // redesenhar só essa linha após um resume, sem header. Reconheça apenas a
  // frase exata produzida pelo Nexus; um erro vivo na linha seguinte fica.
  return out.replace(NEXUS_ACCOUNT_LIMIT_LINE, '');
}

function stripCliSelfManagedThrottle(text: string): string {
  return CLI_SELF_MANAGED_THROTTLE.reduce((out, re) => out.replace(re, ' '), text);
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
}

const BLOCKQUOTE_LINE = /^[ \t]{0,3}(?:>[ \t]?)+/;
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

function isFenceClose(line: string, fence: MarkdownFence): boolean {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(
    match &&
      match[1][0] === fence.marker &&
      match[1].length >= fence.length,
  );
}

function hasLaterFenceClose(
  lines: readonly string[],
  openerIndex: number,
  fence: MarkdownFence,
): boolean {
  for (let index = openerIndex + 1; index < lines.length; index += 1) {
    if (isFenceClose(lines[index], fence)) return true;
  }
  return false;
}

/**
 * Remove spans delimitados por backticks numa linha, preservando a prosa ao
 * redor. Um delimitador sem par é mantido: no PTY ele pode ser saída real, e
 * não há evidência suficiente para silenciar o restante da janela.
 */
function stripInlineCodeSpans(line: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < line.length) {
    const nextBacktick = line.indexOf('`', cursor);
    if (nextBacktick < 0) return out + line.slice(cursor);
    out += line.slice(cursor, nextBacktick);
    cursor = nextBacktick;

    let openerEnd = cursor;
    while (line[openerEnd] === '`') openerEnd += 1;
    const delimiter = line.slice(cursor, openerEnd);
    let searchAt = openerEnd;
    let closeAt = -1;
    while (searchAt < line.length) {
      const candidate = line.indexOf(delimiter, searchAt);
      if (candidate < 0) break;
      const beforeIsBacktick = candidate > 0 && line[candidate - 1] === '`';
      const afterIsBacktick =
        candidate + delimiter.length < line.length &&
        line[candidate + delimiter.length] === '`';
      if (!beforeIsBacktick && !afterIsBacktick) {
        closeAt = candidate;
        break;
      }
      searchAt = candidate + delimiter.length;
    }

    if (closeAt < 0) {
      out += delimiter;
      cursor = openerEnd;
      continue;
    }

    const spanEnd = closeAt + delimiter.length;
    out += ' '.repeat(spanEnd - cursor);
    cursor = spanEnd;
  }
  return out;
}

/**
 * PTY é um stream misto: além da resposta viva do provider, contém Markdown
 * escrito pelo agente, documentação e logs históricos colados. Esses trechos
 * não têm autoridade operacional para disparar failover.
 *
 * A remoção é deliberadamente limitada a estruturas inequívocas:
 * blockquotes, code fences cujo opener está na janela, inline code fechado e
 * linhas explicitamente rotuladas como log/output. Texto fora delas permanece
 * intacto; assim um erro real depois de uma citação continua detectável. Não
 * inferimos que a janela começou dentro de um fence, pois essa heurística
 * poderia apagar um sinal real após o fechamento que ficou sem opener.
 */
function stripQuotedDiagnosticExamples(text: string): string {
  const lines = text.split(/\r?\n/);
  let fence: MarkdownFence | null = null;

  return lines
    .map((line, lineIndex) => {
      if (fence) {
        if (isFenceClose(line, fence)) fence = null;
        return '';
      }

      if (BLOCKQUOTE_LINE.test(line)) return '';

      const fenceMatch = FENCE_LINE.exec(line);
      if (fenceMatch) {
        const delimiter = fenceMatch[1];
        const candidate: MarkdownFence = {
          marker: delimiter[0] as MarkdownFence['marker'],
          length: delimiter.length,
        };
        const info = fenceMatch[2].trim();
        const validInfo =
          candidate.marker === '~' || !info.includes(candidate.marker);
        const unambiguousOpener =
          validInfo &&
          (info.length > 0 ||
            hasLaterFenceClose(lines, lineIndex, candidate));
        if (unambiguousOpener) {
          fence = candidate;
          return '';
        }
      }

      if (isLabeledHistoricalOutput(line)) return '';
      return stripInlineCodeSpans(line);
    })
    .join('\n');
}

/**
 * F-765: o Codex logado com conta ChatGPT recusa o modelo — a conta está
 * sadia, quem não serve o modelo é a combinação conta/CLI (03/10: Codex 0.146
 * com gpt-6.1-sol). Texto real (rollout e print do operador):
 *
 *   ■ {"type":"error","status":400,"error":{"type":"invalid_request_error",
 *   "message":"The 'gpt-6.1-sol' model is not supported when using Codex with
 *   a ChatGPT account."}}
 *
 * A TUI do Codex quebra a célula de erro em várias linhas por conta própria
 * (no print: depois de `"error":` e entre "not" e "supported"); uma regex de
 * linha nunca casava a tela real. A frase é comparada sem espaços nem quebras
 * e só vale dentro de uma célula de erro: a linha que a contém, ou uma das
 * poucas anteriores do mesmo bloco, começa com o marcador ■, `Error:`,
 * `HTTP 400:`, `unexpected status 400` ou o JSON de erro. Prosa que cita a
 * frase no meio da linha (narração, handoff, documentação) não dispara.
 *
 * Linear (F-764): um `replace` na janela e, só quando a frase aparece, um
 * mapa de posições e até CODEX_REJECTION_MAX_HITS × LOOKBACK_LINES linhas.
 */
const CODEX_REJECTION_PHRASE = CODEX_CHATGPT_MODEL_REJECTION.replace(/\s+/g, '');
const CODEX_REJECTION_PHRASE_RE = new RegExp(CODEX_REJECTION_PHRASE, 'gi');
/** Início de célula de erro, ancorado (sticky) no começo de uma linha. */
const CODEX_ERROR_CELL_START =
  /[ \t⎿│]*(?:■|(?:api[ \t]+)?error:|http[ \t]*400:|unexpected[ \t]+status[ \t]+400\b|\{[ \t]*"(?:type|error)"[ \t]*:)/iy;
/**
 * A célula já sem brancos: marcador → (JSON até "message") → the '<modelo>' →
 * frase. Roda ancorada, uma vez por linha candidata, numa fatia curta.
 */
const CODEX_REJECTION_CELL = new RegExp(
  '^[⎿│]*(?:■|(?:api)?error:|http400:|unexpectedstatus400(?:badrequest)?:|(?=\\{"(?:type|error)":))' +
    '(?:http400:|unexpectedstatus400(?:badrequest)?:)?' +
    '(?:\\{.{0,300}?"message":")?' +
    `(?:the(?:'([^']{1,80})'|"([^"]{1,80})"|([a-z0-9._/-]{1,80}?)))?` +
    CODEX_REJECTION_PHRASE,
  'i',
);
const CODEX_REJECTION_LOOKBACK_LINES = 6;
const CODEX_REJECTION_LOOKBACK_CHARS = 480;
const CODEX_REJECTION_MAX_HITS = 8;

function codexChatGptModelRejection(text: string): LimitHit | null {
  // Caso comum (sem a frase): só o replace e uma busca literal.
  const compact = text.replace(/\s+/g, '');
  const starts: number[] = [];
  CODEX_REJECTION_PHRASE_RE.lastIndex = 0;
  for (
    let match = CODEX_REJECTION_PHRASE_RE.exec(compact);
    match;
    match = CODEX_REJECTION_PHRASE_RE.exec(compact)
  ) {
    starts.push(match.index);
  }
  if (starts.length === 0) return null;
  // Posição original de cada caractere não-branco (mesma regra do replace).
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) origin.push(index);
  }
  // A ocorrência mais recente vale mais: a tela atual está no fim da janela.
  for (const start of starts.slice(-CODEX_REJECTION_MAX_HITS).reverse()) {
    const phraseStart = origin[start];
    const phraseEnd = origin[start + CODEX_REJECTION_PHRASE.length - 1] + 1;
    let lineStart = text.lastIndexOf('\n', phraseStart - 1) + 1;
    for (let line = 0; line < CODEX_REJECTION_LOOKBACK_LINES; line += 1) {
      if (phraseStart - lineStart > CODEX_REJECTION_LOOKBACK_CHARS) break;
      CODEX_ERROR_CELL_START.lastIndex = lineStart;
      const cell = CODEX_ERROR_CELL_START.test(text)
        ? CODEX_REJECTION_CELL.exec(text.slice(lineStart, phraseEnd).replace(/\s+/g, ''))
        : null;
      if (cell) {
        const model = (cell[1] ?? cell[2] ?? cell[3])?.slice(0, 40);
        return {
          kind: 'model',
          reason: model
            ? `The '${model}' ${CODEX_CHATGPT_MODEL_REJECTION}`
            : CODEX_CHATGPT_MODEL_REJECTION,
          cooldownMs: 5 * 60 * 1000,
          adapterId: 'codex',
        };
      }
      if (lineStart === 0) break;
      const previous = text.lastIndexOf('\n', lineStart - 2) + 1;
      // Linha em branco fecha a célula: o erro é um bloco contíguo.
      if (!text.slice(previous, lineStart - 1).trim()) break;
      lineStart = previous;
    }
  }
  return null;
}

export function detectLimit(rawText: string, now: number = Date.now()): LimitHit | null {
  const text = stripQuotedDiagnosticExamples(
    stripCliSelfManagedThrottle(stripFailoverHandoffPack(rawText)),
  );
  for (const pattern of candidatePatterns(text)) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const parsed = parseResetCooldown(text, now);
    const scope = extractAnthropicTierScope(text, match.index, match[0].length);
    const cooldownMs =
      pattern.kind === 'auth'
        ? Math.max(parsed ?? pattern.cooldownMs, pattern.cooldownMs)
        : (parsed ?? pattern.cooldownMs);
    return {
      kind: pattern.kind,
      // Sem a moldura da ferramenta de shell ("⎿  ") no motivo do toast.
      reason: match[0].replace(/^[\s⎿│]+/u, '').trim().slice(0, 120),
      cooldownMs,
      ...(scope ? { scope } : {}),
      // F-1410: célula de status/erro desta CLI — confirmado pela posição.
      ...(pattern.adapterId ? { adapterId: pattern.adapterId, confirmed: true } : {}),
    };
  }
  const codexRejection = codexChatGptModelRejection(text);
  if (codexRejection) return codexRejection;
  // Fonte ADICIONAL (vendored de oh-my-pi): taxonomia QUOTA / RATE_LIMIT /
  // CAPACITY / SERVER sobre fraseologia de Anthropic/Google/xAI/provedores
  // chineses que os padrões acima não cobrem. Os padrões legados têm
  // precedência total — zero mudança de kind/cooldown para textos que eles
  // já reconheciam.
  const classified = classifyRateLimitText(text);
  if (classified) {
    const matchedIndex = text.indexOf(classified.matched);
    if (matchedIndex >= 0) {
      const tail = text.slice(
        matchedIndex + classified.matched.length,
        matchedIndex + classified.matched.length + 24,
      );
      if (/^\s*[:=]\s*(?:false|null|0\b)/i.test(tail)) {
        return null;
      }
    }
    const parsed = parseResetCooldown(text, now);
    const scope = extractAnthropicTierScope(
      text,
      matchedIndex >= 0 ? matchedIndex : 0,
      matchedIndex >= 0 ? classified.matched.length : 0,
    );
    return {
      kind: KIND_BY_REASON[classified.reason],
      reason: classified.matched.trim().slice(0, 120),
      cooldownMs: parsed ?? cooldownForReason(classified.reason),
      ...(scope ? { scope } : {}),
    };
  }
  return null;
}
