/**
 * Fonte única dos sinais de limite que o `limit-detector` (Main) reconhece no
 * PTY e da neutralização de texto CITADO que depende deles (F-249/F-511/F-999).
 *
 * Vive em `shared/` (puro, sem Node) porque o pacote de continuidade do
 * failover é montado no Main e no renderer pelo mesmo builder
 * (`failover-handoff.ts`), que neutraliza todo texto citado por construção, e
 * `shared/` não importa de `main/`. O detector importa a tabela daqui: padrão
 * novo entra AQUI, e detector e neutralização seguem juntos (teste anti-drift
 * em `context-handoff-budget.test.ts`).
 */

import { rateLimitTextPatterns } from '../vendor/omp/rate-limit/classify';
import type { FailoverReasonKind } from './account-types';

/**
 * F-765: frase com que o Codex logado em conta ChatGPT recusa um modelo. O
 * detector a compara sem espaços nem quebras (a TUI do Codex quebra a célula
 * de erro em qualquer ponto), e a neutralização segue a mesma regra.
 */
export const CODEX_CHATGPT_MODEL_REJECTION =
  'model is not supported when using Codex with a ChatGPT account';

const CODEX_REJECTION_PHRASE = CODEX_CHATGPT_MODEL_REJECTION.replace(/\s+/g, '');

export interface LimitSignalPattern {
  kind: FailoverReasonKind;
  re: RegExp;
  cooldownMs: number;
}

const HOUR = 60 * 60 * 1000;

// Order matters: quota before rate-limit before auth.
// Patterns stay error-shaped to avoid false positives on docs/agent prose.
export const LIMIT_SIGNAL_PATTERNS: readonly LimitSignalPattern[] = [
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
  // F-992: Claude Code (TUI e -p) com modelo que a CLI/conta não serve — o
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

/** F-511: a 2ª linha de um pack antigo, exatamente como o Nexus a escreve. */
export const NEXUS_ACCOUNT_LIMIT_LINE =
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
export const CLI_SELF_MANAGED_THROTTLE: readonly RegExp[] = [
  /\bRate\s+limited…/g,
  /\bProvider\s+rate\s+limit;\s+subagent\s+requeued\s+for\s+retry\.?/gi,
  /\bprovider\s+rate\s+limit\s+hit\s+[—–-]+\s+new\s+tower\s+spawns\s+paused\s+for\s+~?\d+s\b/gi,
  /\bspawns\s+PAUSED\s+for\s+~?\d+s\s+\(provider\s+rate\s+limit\s+[—–-]+\s+successful\s+requests\s+lift\s+the\s+pause\s+early\)/gi,
];

const LOG_OUTPUT_LABEL =
  /^(?:(?:logs?|log output)|output(?: log| excerpt)?|(?:terminal|command|console) output|stdout|stderr|sa[ií]da(?: (?:do|de) (?:log|terminal|comando|console))?|trecho (?:do|de) (?:log|sa[ií]da))$/i;

export function isLabeledHistoricalOutput(line: string): boolean {
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

/* ------------------------------------------------------------------------ *
 * ORC-05 / F-249: neutralização de texto CITADO (histórico de handoff).
 *
 * O recorte de contexto de uma troca já decidida leva texto do terminal
 * antigo, que o pane novo ecoa no PTY. O reducer reavalia janelas de 4.000
 * chars que começam e terminam em qualquer ponto do eco; o header do pack sai
 * da janela e o erro citado viraria sinal vivo (quarentena do modelo atual,
 * troca de uma sessão sã). A fonte é ÚNICA: os próprios padrões do detector
 * (a tabela acima, classify do omp, célula do Codex, estrangulamento de CLI e
 * a linha F-511), em versão permissiva — sem âncoras, fronteiras de palavra
 * nem lookaround, `$` opcional — para cobrir qualquer corte de janela. O
 * builder do pack (`failover-handoff.ts`) aplica a todo texto citado (F-999).
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
    ...LIMIT_SIGNAL_PATTERNS.map((pattern) => pattern.re),
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
