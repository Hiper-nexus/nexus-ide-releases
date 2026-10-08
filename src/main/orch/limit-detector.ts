/**
 * Detects, from a CLI's terminal output, that the current account hit a limit
 * and work can't continue on it. Input must be ANSI-stripped. Pure function —
 * unit tested. The failover engine feeds it a rolling window of recent output.
 */

import {
  backoffMsForReason,
  classifyRateLimitText,
  rateLimitTextPatterns,
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
  const near = text.slice(start, end);
  const fullId = CLAUDE_MODEL_ID.exec(near);
  if (fullId) {
    const scoped = tierScopeFromModelId(fullId[0]);
    if (scoped) return scoped;
  }
  const bare = BARE_ANTHROPIC_FAMILY.exec(near);
  return bare ? `tier:${bare[1].toLowerCase()}` : undefined;
}

interface Pattern {
  kind: LimitKind;
  re: RegExp;
  cooldownMs: number;
}

const HOUR = 60 * 60 * 1000;

// Order matters: quota before rate-limit before auth.
// Patterns stay error-shaped to avoid false positives on docs/agent prose.
const PATTERNS: Pattern[] = [
  // Credits / quota exhausted — long cooldown.
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /insufficient[_\s]?quota/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /credit balance is too low/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /quota (?:exceeded|exhausted)/i },
  // Ordem inversa da mesma frase. A OpenAI escreve "You exceeded your current
  // quota, please check your plan and billing details" — o padrão acima só
  // casa "quota exceeded", então a mensagem HUMANA passava batido sempre que a
  // CLI imprimia o texto sem o código `insufficient_quota` ao lado. Provado em
  // campo com os quatro textos reais de esgotamento: era o único não
  // reconhecido, e não reconhecer significa não trocar de conta.
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /exceeded your (?:current |monthly |plan )?quota/i },
  // Error-shaped (like the 429 pattern below): a bare status number only counts
  // as a limit when framed by http/status/error — never a bare "402" in prose or
  // in Nexus's own handoff text (which echoes the code back onto the PTY).
  {
    kind: 'quota',
    cooldownMs: 12 * HOUR,
    re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*(?:[:=]\s*)?|error\s*(?:[:=]\s*)?)402\b|payment required/i,
  },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /out of credits|no credits remaining/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /billing[_\s]?hard[_\s]?limit/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /you['’]ve used all of your (?:credits|quota|plan)/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /(?:plan|subscription) limit (?:reached|exceeded)/i },
  // Weekly / plan exhaustion → long cooldown + weekly UI window (kind quota).
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /weekly (?:usage )?limit (?:reached|exceeded|hit)/i },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /reached your weekly limit/i },
  // PT: cota / créditos — require error/limit/outcome context (no bare prose).
  {
    kind: 'quota',
    cooldownMs: 12 * HOUR,
    re: /(?:erro|error|failed|falha|limite|limit)[:\s].{0,60}(?:cota (?:esgotada|excedida)|cr[eé]ditos? insuficientes|sem cr[eé]ditos?)/i,
  },
  {
    kind: 'quota',
    cooldownMs: 12 * HOUR,
    re: /(?:cota (?:esgotada|excedida)|cr[eé]ditos? insuficientes).{0,40}(?:erro|failed|upgrade|plano|limit|limite)/i,
  },
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /limite (?:do )?plano (?:atingido|excedido)|assinatura (?:esgotada|excedida)/i },
  // Rate / usage limit — resets within a window (not weekly — see quota above).
  // Prefixo `⎿`/`│`: a saída de um `claude -p` filho chega ao PTY do pane
  // emoldurada pela ferramenta de shell do Claude Code ("⎿  You've hit…"), e
  // o limite do filho é o da MESMA conta do pane — sem reconhecer a moldura
  // o failover nunca disparava e o pane ficava preso na conta esgotada.
  //
  // F-764: a moldura é só da LINHA — espaço horizontal (`\s` sem quebras) e
  // ⎿│ — e não se sobrepõe ao que vem depois. O antigo `^[\s⎿│]*…\s*`
  // atravessava `\n` e disputava os espaços com o `\s*` seguinte: numa tela
  // de TUI em branco a busca ficava cúbica (300 ms por janela de 4 KB, a cada
  // chunk de PTY) e congelou a main thread com 12 panes vivos.
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:[^\S\r\n\u2028\u2029]|[⎿│])*(?:(?:claude|error:?)[^\S\r\n\u2028\u2029]*)?usage limit reached(?:[.!\s]|$)/im },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:[^\S\r\n\u2028\u2029]|[⎿│])*(?:(?:claude|error:?)[^\S\r\n\u2028\u2029]*)?(?:you(?:'ve| have) )?reached your (?:usage|5-hour|daily|session) limit(?:[.!\s·]|$)/im },
  // 2026-09: "You've hit your session limit · resets 8:10pm (America/Sao_Paulo)"
  // (janela rolante de 5h da conta Claude, com o reset em hora local).
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:[^\S\r\n\u2028\u2029]|[⎿│])*(?:(?:claude|error:?)[^\S\r\n\u2028\u2029]*)?(?:you(?:'ve| have) )?hit your (?:usage|rate|token|session) limit(?:[.!\s·]|$)/im },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /5[-\s]?hour (?:usage )?limit (?:reached|exceeded|hit)/i },
  // PT: limite de uso / 5 horas (error-shaped).
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /limite de (?:uso|utiliza[cç][aã]o) (?:atingido|excedido|alcan[cç]ado)/i },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /limite de 5\s*horas? (?:atingido|excedido)/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /erro[:\s].{0,40}limite de (?:taxa|requisi[cç][oõ]es)/i },
  // Never match the bare phrase "rate limit": squad instructions legitimately
  // mention it ("em rate limit, re-roteie") and are echoed into the PTY. A
  // limit signal must carry error/outcome semantics.
  {
    kind: 'rate-limit',
    cooldownMs: HOUR,
    // Grafias reais de provider que carregam semântica de erro por si:
    // rate_limit_exceeded / rate_limit_reached (código da OpenAI, separador
    // underscore) e RateLimitError (classe de exceção dos SDKs, CamelCase).
    // A prosa nua "rate limit" continua fora (ver comentário acima).
    re: /rate[_\s]?limit(?:ed|_error)|rate[_\s]?limit[_\s]+(?:exceeded|reached|hit)|ratelimiterror|rate[_\s]?limit.{0,24}\btry again\b|(?:error|failed|failure)\b[^|\n]{0,40}\brate[_\s]?limit/i,
  },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*(?:[:=]\s*)?|error\s*(?:[:=]\s*)?)429\b|too many requests/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /resource[_\s]?exhausted/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /(?:tokens? per min(?:ute)?|tpm) (?:limit|exceeded)/i },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /(?:requests? per min(?:ute)?|rpm) (?:limit|exceeded)/i },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /primary[_\s]?ip[_\s]?rate[_\s]?limit/i },
  {
    kind: 'rate-limit',
    cooldownMs: 5 * HOUR,
    re: /(?:codex|chatgpt).{0,40}(?:usage|rate)\s+limit\s+(?:reached|exceeded|hit)/i,
  },
  {
    kind: 'rate-limit',
    cooldownMs: 5 * HOUR,
    re: /(?:grok|xai).{0,40}(?:rate|usage)\s+limit\s+(?:reached|exceeded|hit)/i,
  },
  // Auth expiry — switching accounts may recover. Error-shaped like 429/402:
  // a bare "401" must be framed (HTTP 401 / status: 401 / error: 401 / 401
  // Unauthorized) or carry authentication_error. A naked "401" — as in the
  // failover handoff pack "hit a provider limit (401 …)" echoed back onto the
  // PTY, or agent prose about a 401 — must NOT re-arm failover (phantom loop).
  {
    kind: 'auth',
    cooldownMs: 15 * 60 * 1000,
    re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*(?:[:=]\s*)?|error\s*(?:[:=]\s*)?)401\b|401\s+unauthorized|authentication[_\s]?error/i,
  },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /invalid[_\s]?(?:api[_\s]?key|x-api-key)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /oauth token (?:expired|revoked)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /(?:error|failed|unable).{0,40}(?:not logged in|session expired)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /refresh token (?:expired|invalid|revoked)/i },
  // Kimi Code / Claude-family CLI: refresh rotacionado por outro ator
  // (sonda de cota, overlay) — o pane ecoa isto e pede /login.
  {
    kind: 'auth',
    cooldownMs: 15 * 60 * 1000,
    re: /stored token for ["'][^"']+["'] was rejected/i,
  },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /(?:erro|falha).{0,40}(?:n[aã]o autenticado|sess[aã]o expirada|token inv[aá]lido)/i },
  // Modelo rejeitado — a CONTA está sadia (F-520): o failover troca o modelo
  // do pane (migração/default do catálogo) e religa na mesma conta, em vez
  // de punir a credencial com cooldown. Error-shaped como 429/402/401 acima:
  // casa apenas os formatos CANÔNICOS das mensagens reais de provider — a
  // prosa nua "model not found" (docs/agente citando o erro) jamais dispara,
  // porque disparar aqui mata uma sessão sadia e reescreve o modelo do pane.
  //
  // Textos reais verificados:
  // - Codex CLI desatualizada: "The 'gpt-6-astra' model requires a newer
  //   version of Codex. Please upgrade…" (2026-09-14)
  // - OpenAI: "The model 'gpt-x' does not exist or you do not have access
  //   to it" / código model_not_found
  // - Anthropic: "not_found_error: model: …"
  // - Gemini: "models/gemini-x is not found"
  // - Codex com conta ChatGPT (F-765): matcher próprio, abaixo dos padrões.
  { kind: 'model', cooldownMs: 5 * 60 * 1000, re: /model requires a newer version/i },
  {
    kind: 'model',
    cooldownMs: 5 * 60 * 1000,
    re: /model ['"][^'"]{1,64}['"] (?:does not exist|is not found|was not found|is not supported)/i,
  },
  { kind: 'model', cooldownMs: 5 * 60 * 1000, re: /\bnot_found_error:[^\n]{0,60}\bmodel\b/i },
  // F-966: Claude Code (TUI e -p) com modelo que a CLI/conta não serve — o
  // texto do 404 é este nas 2.1.283 e 2.1.293 (strings do binário). Sem ele o
  // modelo recusado nunca entrava na quarentena e o roteador insistia.
  {
    kind: 'model',
    cooldownMs: 5 * 60 * 1000,
    re: /There's an issue with the selected model \([^)\n]{1,80}\)\. It may not exist or you may not have access to it/i,
  },
  { kind: 'model', cooldownMs: 5 * 60 * 1000, re: /\bmodels\/[a-z0-9][a-z0-9.-]{0,80}\s+is not found\b/i },
  { kind: 'model', cooldownMs: 5 * 60 * 1000, re: /\b(?:model_not_found|model_not_supported)\b/i },
  // F-683: OpenCode Zen com o modelo desligado para a conta (29/09):
  // "Error: Upstream request failed: Model access is disabled".
  { kind: 'model', cooldownMs: 5 * 60 * 1000, re: /upstream request failed:\s*model access is disabled/i },
];

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
  const clock = parseResetClockMs(cleaned, now);
  if (clock !== null) return clock;
  return parseRetryAfterMsFromText(cleaned, now);
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

/** F-511: a 2ª linha de um pack antigo, exatamente como o Nexus a escreve. */
const NEXUS_ACCOUNT_LIMIT_LINE =
  /^[ \t]*Account "[^\r\n]*" hit a provider limit \([^\r\n]*\)\.[ \t]*$/gm;

/**
 * F-718: estrangulamento que a PRÓPRIA CLI administra não é limite da conta.
 *
 * O Kimi Code (2.1) roda subagentes em enxame. No 429 de concorrência da
 * Moonshot ele entra em modo de taxa: re-enfileira o subagente com backoff
 * (3 s, 6 s, 12 s…), encolhe a capacidade e a recupera em ~3 min. O painel
 * mostra "Rate limited…" (SUSPENDED_LABEL, com reticências U+2026), e o tower
 * pausa spawns por segundos. Esses textos casavam o padrão de 1 h e o Nexus
 * avisava "Limite temporário" com a cota em 73% (print de 01/10). Só as
 * frases exatas da CLI saem; o erro que derruba o agente continua detectado.
 */
const CLI_SELF_MANAGED_THROTTLE: readonly RegExp[] = [
  /\bRate\s+limited…/g,
  /\bProvider\s+rate\s+limit;\s+subagent\s+requeued\s+for\s+retry\.?/gi,
  /\bprovider\s+rate\s+limit\s+hit\s+[—–-]+\s+new\s+tower\s+spawns\s+paused\s+for\s+~?\d+s\b/gi,
  /\bspawns\s+PAUSED\s+for\s+~?\d+s\s+\(provider\s+rate\s+limit\s+[—–-]+\s+successful\s+requests\s+lift\s+the\s+pause\s+early\)/gi,
];

function stripCliSelfManagedThrottle(text: string): string {
  return CLI_SELF_MANAGED_THROTTLE.reduce((out, re) => out.replace(re, ' '), text);
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
}

const BLOCKQUOTE_LINE = /^[ \t]{0,3}(?:>[ \t]?)+/;
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const LOG_OUTPUT_LABEL =
  /^(?:(?:logs?|log output)|output(?: log| excerpt)?|(?:terminal|command|console) output|stdout|stderr|sa[ií]da(?: (?:do|de) (?:log|terminal|comando|console))?|trecho (?:do|de) (?:log|sa[ií]da))$/i;

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
    if (line[cursor] !== '`') {
      out += line[cursor];
      cursor += 1;
      continue;
    }

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

function isLabeledHistoricalOutput(line: string): boolean {
  let candidate = line
    .replace(/^[ \t]{0,3}(?:(?:[-*+]|\d+[.)])[ \t]+)?/, '')
    .trimStart();

  // Aceita rótulos de prosa como `**Output:**`, `_Saída do log_:`, sem
  // transformar qualquer bullet com `Error:` em histórico.
  const emphasized = /^([*_]{1,2})([^*_]{1,80})\1/.exec(candidate);
  if (emphasized) {
    candidate = emphasized[2] + candidate.slice(emphasized[0].length);
  }
  // O rótulo é aparado logo abaixo: basta o 1º separador. O antigo
  // /\s*[:=-]\s*/ ficava quadrático numa linha longa de espaços (F-764).
  const separatorAt = candidate.search(/[:=-]/);
  if (separatorAt < 0) return false;
  return LOG_OUTPUT_LABEL.test(candidate.slice(0, separatorAt).trim());
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
  for (const pattern of PATTERNS) {
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

/* ------------------------------------------------------------------------ *
 * ORC-05 / F-249: neutralização de texto CITADO (histórico de handoff).
 *
 * O recorte de contexto de uma troca já decidida leva texto do terminal
 * antigo, que o pane novo ecoa no PTY. O reducer reavalia janelas de 4.000
 * chars que começam e terminam em qualquer ponto do eco; o header do pack sai
 * da janela e o erro citado viraria sinal vivo (quarentena do modelo atual,
 * troca de uma sessão sã). A fonte é ÚNICA: os próprios padrões deste
 * detector (PATTERNS, classify do omp, célula do Codex, estrangulamento de
 * CLI e a linha F-511), em versão permissiva — sem âncoras, fronteiras de
 * palavra nem lookaround, `$` opcional — para cobrir qualquer corte de janela.
 * ------------------------------------------------------------------------ */

/** Quebra visível no sinal citado: não é branco, `_`, `-` nem moldura. */
const QUOTED_SIGNAL_BREAK = '‧';
const MAX_NEUTRALIZE_PASSES = 32;

/** Variante que casa o trecho em qualquer janela que corte o texto. */
function permissiveSignal(re: RegExp): RegExp {
  const source = re.source
    .replace(/\(\?<?[=!][^()]*\)/g, '')
    .replace(/\\b/g, '')
    .replace(/^\^/, '')
    .replace(/\|\$\)/g, '|)')
    .replace(/(?<!\\)\$$/, '');
  return new RegExp(source, `${re.flags.replace(/[gy]/g, '')}g`);
}

let quotedSignalPatternsCache: readonly RegExp[] | null = null;

/** Padrões do detector usados na neutralização (exposto para o teste anti-drift). */
export function quotedLimitSignalPatterns(): readonly RegExp[] {
  quotedSignalPatternsCache ??= [
    ...PATTERNS.map((pattern) => pattern.re),
    ...rateLimitTextPatterns(),
    ...CLI_SELF_MANAGED_THROTTLE,
    NEXUS_ACCOUNT_LIMIT_LINE,
    new RegExp(CODEX_REJECTION_PHRASE.split('').join('\\s*'), 'i'),
  ].map(permissiveSignal);
  return quotedSignalPatternsCache;
}

function breakQuotedSignal(match: string): string {
  const at = match.search(/[\p{L}\p{N}]/u);
  return at < 0 ? match : `${match.slice(0, at + 1)}${QUOTED_SIGNAL_BREAK}${match.slice(at + 1)}`;
}

/**
 * Torna texto citado inerte para `detectLimit` em qualquer janela: brancos
 * normalizados (uma TUI que colapse espaços não recompõe a frase), estruturas
 * que o detector descarta neutralizadas (crase, blockquote, fence, rótulo de
 * log — descartá-las juntaria linhas vizinhas) e cada sinal reconhecido
 * quebrado por um caractere visível, até ponto fixo.
 */
export function neutralizeLimitSignals(raw: string): string {
  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replaceAll('`', "'")
    .replace(/^( {0,3})>/gm, '$1›')
    .replace(/^( {0,3})~{3,}/gm, '$1- - -')
    .split('\n')
    .map((line) => (isLabeledHistoricalOutput(line) ? `${QUOTED_SIGNAL_BREAK} ${line}` : line))
    .join('\n');
  for (let pass = 0; pass < MAX_NEUTRALIZE_PASSES; pass += 1) {
    let changed = false;
    for (const re of quotedLimitSignalPatterns()) {
      text = text.replace(re, (match: string) => {
        const broken = breakQuotedSignal(match);
        if (broken !== match) changed = true;
        return broken;
      });
    }
    if (!changed) return text;
  }
  // Sem ponto fixo (não deveria acontecer): o trecho inteiro sai.
  for (const re of quotedLimitSignalPatterns()) {
    text = text.replace(re, '[sinal de limite citado]');
  }
  return text;
}
