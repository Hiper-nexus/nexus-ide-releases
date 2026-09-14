// Derived from can1357/oh-my-pi@03c48d073 packages/ai/src/error/rate-limit.ts (MIT)
/**
 * Classificação de esgotamento/limite a partir de TEXTO de erro de provider.
 *
 * Taxonomia e durações portadas do oh-my-pi (`parseRateLimitReason` +
 * `calculateRateLimitBackoffMs`). Adaptações para o Nexus:
 *
 * - A fonte original classifica mensagens que JÁ se sabe serem erros (corpo de
 *   resposta HTTP de uma chamada que falhou). O Nexus lê uma janela de PTY
 *   arbitrária (prosa de agente, docs, logs do app do usuário), então padrões
 *   que no omp eram `includes()` frouxos ("capacity", "quota", "exhausted",
 *   "500", "per minute") foram apertados para exigir formato de erro — cada
 *   aperto está documentado no próprio padrão.
 * - Sem API Bun; TypeScript puro, sem dependências.
 * - Além do reason, expomos o trecho casado (`matched`) para alimentar o campo
 *   `reason` do limit-detector do Nexus.
 */

export type RateLimitReason =
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'MODEL_CAPACITY_EXHAUSTED'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

/** Reason efetivamente classificado (nunca UNKNOWN — sem match retorna null). */
export type ClassifiedReason = Exclude<RateLimitReason, 'UNKNOWN'>;

// Durações do omp (calculateRateLimitBackoffMs) — transitórios são CURTOS.
export const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
export const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
export const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
export const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // +0..30s de jitter
export const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

export interface RateLimitClassification {
  reason: ClassifiedReason;
  /** Trecho do texto que casou (para logs / campo reason). */
  matched: string;
}

interface ReasonPattern {
  reason: ClassifiedReason;
  re: RegExp;
}

/**
 * Padrões na MESMA ordem de prioridade do omp:
 * QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (conta) >
 * RATE_LIMIT > QUOTA (genérico) > SERVER_ERROR.
 */
const REASON_PATTERNS: readonly ReasonPattern[] = [
  // ── 1. QUOTA — fraseologia Google/Antigravity de cota diária esgotada.
  // "You have exhausted your capacity on this model. Your quota will reset
  // after …" — precisa vir ANTES de MODEL_CAPACITY (o literal "capacity"
  // pré-emptaria o branch de quota, exatamente o bug corrigido no omp).
  // Frases específicas o bastante para casar nuas.
  { reason: 'QUOTA_EXHAUSTED', re: /quota will reset/i },
  { reason: 'QUOTA_EXHAUSTED', re: /exhausted your capacity/i },

  // ── 2. MODEL_CAPACITY — transitório: capacidade do modelo/servidor.
  // omp usava includes("capacity") nu — frouxo demais para PTY ("disk
  // capacity", "capacity planning"). Exigimos semântica de falta/estouro.
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /\b(?:model|server|service)\b[^\n]{0,30}\b(?:at|over|out of)\s+capacity\b/i },
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /\bcapacity\s+(?:exhausted|exceeded|unavailable|constraints?)\b/i },
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /\b(?:no|insufficient)\s+capacity\b/i },
  // omp: includes("overloaded") — código Anthropic; carrega erro por si. No
  // Nexus este branch preserva a semântica transitória e o backoff curto.
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /\boverloaded(?:_error)?\b/i },
  // omp: includes("529")/includes("503") nus — inaceitável em PTY (números de
  // linha, portas). Mesmo shape de prefixo do 429 legado do Nexus, ou o
  // reason-phrase do HTTP junto do código.
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*|error\s*[:=]?\s*|code\s*[:=]?\s*)(?:529|503)\b/i },
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /\b(?:529|503)\s+(?:service\s+unavailable|overloaded)\b/i },
  // omp: includes("resource exhausted") — código do Google (gRPC). No Nexus o
  // legado classifica antes como rate-limit; mantido por fidelidade.
  { reason: 'MODEL_CAPACITY_EXHAUSTED', re: /resource[_\s]exhausted/i },

  // ── 3. QUOTA — rate-limit de CONTA (Anthropic): cap local da conta, não
  // taxa transitória. O ACCOUNT_RATE_LIMIT_PATTERN do omp aceitava qualquer
  // "account" a ≤80 chars de "rate limit" — casaria prosa de instrução de
  // squad ("switch account on rate limit"). Exigimos verbo de resultado.
  { reason: 'QUOTA_EXHAUSTED', re: /\baccount(?:'s)?\b[^\n]{0,60}\brate[-_\s]?limit(?:ed)?\b[^\n]{0,40}\b(?:exceeded|reached|hit)\b/i },
  { reason: 'QUOTA_EXHAUSTED', re: /\baccount (?:has been|was|is) rate[-_\s]?limited\b/i },
  { reason: 'QUOTA_EXHAUSTED', re: /rate[-_\s]?limit (?:exceeded|reached) for (?:your|this) account/i },

  // ── 4. RATE_LIMIT — transitório curto: taxa por minuto / 429 com corpo.
  // omp usava includes("per minute") nu — docs legítimas dizem "60 requests
  // per minute". Exigimos verbo de estouro perto da janela.
  { reason: 'RATE_LIMIT_EXCEEDED', re: /\b(?:exceeded|reached|hit)\b[^\n]{0,40}\bper[- ]min(?:ute)?\b/i },
  { reason: 'RATE_LIMIT_EXCEEDED', re: /\bper[- ]min(?:ute)?\b[^\n]{0,40}\b(?:exceeded|reached|hit)\b/i },
  // omp: includes("rate limit") nu — proibido no Nexus (prosa de squad ecoada
  // no PTY menciona a frase). Só grafias com erro embutido.
  { reason: 'RATE_LIMIT_EXCEEDED', re: /rate[-_\s]?limit[-_\s]?(?:exceeded|reached|error)\b/i },
  { reason: 'RATE_LIMIT_EXCEEDED', re: /\b(?:error|failed|failure|exception)\b[^\n]{0,40}\brate[-_\s]?limit/i },
  // Reason-phrase do HTTP 429 — carrega erro por si.
  { reason: 'RATE_LIMIT_EXCEEDED', re: /too many requests/i },
  // omp: includes("presque") (Antigravity em francês, "quase") — nu é frouxo
  // demais; exigimos vizinhança de quota/limite.
  { reason: 'RATE_LIMIT_EXCEEDED', re: /quota[^\n]{0,30}presque|presque[^\n]{0,30}(?:atteinte?|limite|[eé]puis[eé]e?)/i },

  // ── 5. QUOTA — genérico: créditos/cota da conta esgotados (rotacionar).
  { reason: 'QUOTA_EXHAUSTED', re: /quota[-_\s]?(?:exceeded|exhausted|reached|insufficient)/i },
  { reason: 'QUOTA_EXHAUSTED', re: /insufficient[-_\s]?(?:quota|balance)/i },
  // omp: includes("exhausted") nu — exigimos o recurso esgotado por perto.
  { reason: 'QUOTA_EXHAUSTED', re: /\b(?:quota|credits?|allowance|budget|balance)\b[^\n]{0,20}\bexhausted\b/i },
  { reason: 'QUOTA_EXHAUSTED', re: /exhausted (?:your|the|all) (?:quota|credits?)/i },
  // xAI SuperGrok: HTTP 403 "run out of credits" — cap local da conta.
  { reason: 'QUOTA_EXHAUSTED', re: /(?:run out of|out of) credits\b|no credits remaining/i },
  // omp: "spending limit" nu casaria "set a spending limit" em docs.
  { reason: 'QUOTA_EXHAUSTED', re: /spending[-_\s]?limit\b[^\n]{0,30}\b(?:reached|exceeded|hit)\b|\b(?:reached|exceeded|hit)\b[^\n]{0,30}\bspending[-_\s]?limit\b/i },
  // Códigos com underscore do USAGE_LIMIT_PATTERN do omp — error-shaped por
  // si. A forma em texto livre "usage limit" foi EXCLUÍDA de propósito: colide
  // com prosa ("Codex has no usage limit…"); o legado do Nexus tem as versões
  // ancoradas em início de linha. Exige confirmação de erro ou : true para não
  // disparar em telemetria normal do Codex ("limit_reached": false).
  {
    reason: 'QUOTA_EXHAUSTED',
    re: /usage_limit_reached|usage_not_included|personal-team-blocked|(?<![a-z0-9_-])limit_reached\s*[:=]\s*true\b|(?<![a-z0-9_-])(?:error|status|failed)[:\s][^\n]{0,30}\blimit_reached\b/i,
  },
  // Provedores chineses (GLM/DeepSeek…): 额度不足 = "cota insuficiente",
  // 额度耗尽 = "cota esgotada". Específicos o bastante para casar nus.
  { reason: 'QUOTA_EXHAUSTED', re: /额度不足|额度耗尽/ },

  // ── 6. SERVER_ERROR — transitório: 5xx interno do provider.
  // omp usava includes("500")/includes("internal error") nus. Em PTY, "500"
  // aparece em qualquer número e "internal server error" em logs do app do
  // PRÓPRIO usuário (curl num dev server). Exigimos shape de status/código.
  // Falso positivo residual (agente cita um 500 do provider em prosa) custa
  // só 20s de cooldown, debounced pelo failover.
  { reason: 'SERVER_ERROR', re: /(?:http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*|error\s*[:=]?\s*|code\s*[:=]?\s*)500\b/i },
  { reason: 'SERVER_ERROR', re: /\b500\s+internal\s+server\s+error\b/i },
  { reason: 'SERVER_ERROR', re: /\binternal[_-]server[_-]error\b|\binternal_error\b/i },
  { reason: 'SERVER_ERROR', re: /\binternal (?:server )?error\b[^\n]{0,20}\b(?:occurred|encountered)\b/i },
];

/**
 * Classifica texto de erro de provider na taxonomia do omp. Retorna null em
 * vez de UNKNOWN: no Nexus, ausência de match significa "não é sinal de
 * limite" (a janela de PTY quase nunca é um erro).
 */
export function classifyRateLimitText(text: string): RateLimitClassification | null {
  for (const pattern of REASON_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) {
      return { reason: pattern.reason, matched: match[0] };
    }
  }
  return null;
}

/**
 * Backoff em ms por reason (calculateRateLimitBackoffMs do omp).
 * MODEL_CAPACITY leva jitter para evitar thundering herd; `random` é
 * injetável para testes determinísticos.
 */
export function backoffMsForReason(
  reason: RateLimitReason,
  random: () => number = Math.random,
): number {
  switch (reason) {
    case 'QUOTA_EXHAUSTED':
      return QUOTA_EXHAUSTED_BACKOFF_MS;
    case 'RATE_LIMIT_EXCEEDED':
      return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
    case 'MODEL_CAPACITY_EXHAUSTED':
      return MODEL_CAPACITY_BASE_MS + Math.floor(random() * MODEL_CAPACITY_JITTER_MS);
    case 'SERVER_ERROR':
      return SERVER_ERROR_BACKOFF_MS;
    default:
      return QUOTA_EXHAUSTED_BACKOFF_MS; // padrão conservador (omp)
  }
}
