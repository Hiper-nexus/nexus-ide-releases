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

/**
 * - 'quota': conta/plano esgotado — cooldown longo, pinta a janela Semanal.
 * - 'rate-limit': janela rolante (5h) ou taxa por minuto — cooldown médio.
 * - 'auth': credencial expirada/inválida — trocar de conta pode recuperar.
 * - 'transient': blip do provedor (capacidade do modelo / 5xx) — cooldown de
 *   SEGUNDOS; não é janela de uso (a conta volta sozinha).
 */
export type LimitKind = 'rate-limit' | 'quota' | 'auth' | 'transient';

export interface LimitHit {
  kind: LimitKind;
  reason: string;
  /** Suggested cooldown in ms before this account is retried. */
  cooldownMs: number;
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
  { kind: 'quota', cooldownMs: 12 * HOUR, re: /\b402\b|payment required/i },
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
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:claude|error:?)?\s*usage limit reached(?:[.!\s]|$)/im },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:claude|error:?)?\s*(?:you(?:'ve| have) )?reached your (?:usage|5-hour|daily) limit(?:[.!\s]|$)/im },
  { kind: 'rate-limit', cooldownMs: 5 * HOUR, re: /^(?:claude|error:?)?\s*(?:you(?:'ve| have) )?hit your (?:usage|rate|token) limit(?:[.!\s]|$)/im },
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
    re: /rate[_\s]?limit(?:ed|_error)|rate[_\s]?limit[_\s]+(?:exceeded|reached|hit)|ratelimiterror|rate[_\s]?limit.{0,24}\btry again\b|(?:error|failed|failure)\b.{0,40}\brate[_\s]?limit/i,
  },
  { kind: 'rate-limit', cooldownMs: HOUR, re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*|error\s*[:=]?\s*)429\b|too many requests/i },
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
  { kind: 'rate-limit', cooldownMs: 15 * 60 * 1000, re: /overloaded(?:_error)?/i },
  // Auth expiry — switching accounts may recover.
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /\b401\b|authentication[_\s]?error/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /invalid[_\s]?(?:api[_\s]?key|x-api-key)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /oauth token (?:expired|revoked)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /(?:error|failed|unable).{0,40}(?:not logged in|session expired)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /refresh token (?:expired|invalid|revoked)/i },
  { kind: 'auth', cooldownMs: 15 * 60 * 1000, re: /(?:erro|falha).{0,40}(?:n[aã]o autenticado|sess[aã]o expirada|token inv[aá]lido)/i },
];

/**
 * Try to read an explicit reset time ("resets at 3pm", "try again in 42
 * minutes") to size the cooldown precisely; falls back to the pattern default.
 * O parser vendorado do omp cobre as variantes extras (hint `retry-after-ms=`,
 * headers ecoados no terminal, prosa "retry in 26.3s").
 */
function parseResetCooldown(text: string): number | null {
  const mins = /try again in (\d+)\s*(?:minute|min)/i.exec(text);
  if (mins) return Number(mins[1]) * 60 * 1000;
  const secs = /try again in (\d+)\s*(?:second|sec)/i.exec(text);
  if (secs) return Number(secs[1]) * 1000;
  const hrs = /(?:resets?|available again) in (\d+)\s*hour/i.exec(text);
  if (hrs) return Number(hrs[1]) * HOUR;
  return parseRetryAfterMsFromText(text);
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

export function detectLimit(text: string): LimitHit | null {
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const parsed = parseResetCooldown(text);
    return {
      kind: pattern.kind,
      reason: match[0].trim().slice(0, 120),
      cooldownMs: parsed ?? pattern.cooldownMs,
    };
  }
  // Fonte ADICIONAL (vendored de oh-my-pi): taxonomia QUOTA / RATE_LIMIT /
  // CAPACITY / SERVER sobre fraseologia de Anthropic/Google/xAI/provedores
  // chineses que os padrões acima não cobrem. Os padrões legados têm
  // precedência total — zero mudança de kind/cooldown para textos que eles
  // já reconheciam.
  const classified = classifyRateLimitText(text);
  if (classified) {
    const parsed = parseResetCooldown(text);
    return {
      kind: KIND_BY_REASON[classified.reason],
      reason: classified.matched.trim().slice(0, 120),
      cooldownMs: parsed ?? cooldownForReason(classified.reason),
    };
  }
  return null;
}
