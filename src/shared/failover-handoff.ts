/**
 * Stable markers and pure builder for the multi-account failover continuity
 * pack (F-775).
 *
 * The pack is Nexus's own text, injected into the replacement pane's PTY after
 * a cross-account switch. It quotes the prior limit reason and a scrollback
 * excerpt of the previous terminal — both carry verbatim provider error phrases.
 * The failover limit-detector taps that same PTY, so it MUST recognise and skip
 * this self-authored block; otherwise it re-fires on every replacement account,
 * cascading the whole fleet into cooldown (the phantom-limit loop).
 *
 * Shared between the renderer builder (`failover-continuity.ts`), the
 * main-owned respawn (`failover-mission-respawn.ts`) and the detector
 * (`limit-detector.ts`) so the three never drift apart.
 */

import { maskAccountLabel } from './account-choice';

/** First line of every continuity pack. */
export const FAILOVER_HANDOFF_HEADER = '[NEXUS FAILOVER HANDOFF]';

/** Last line of every continuity pack. */
export const FAILOVER_HANDOFF_FOOTER = 'Execute the next concrete step now.';

/**
 * Teto do pack inteiro. O detector vive numa janela rolante de 4000 chars e o
 * pack é digitado no PTY novo — sem teto, um scrollback gordo virava contexto
 * infinito e o header saía da janela com o excerpt de erro ainda dentro.
 */
export const MAX_CONTINUITY_PACK_CHARS = 6_000;

/**
 * Espelho de citação dos gatilhos de `limit-detector.ts` (F-511).
 *
 * O detector varre uma janela rolante de 4000 chars: quando o header do pack
 * sai da janela mas o excerpt ainda está nela, o 401 CITADO da sessão morta
 * casa como sinal vivo e o failover re-dispara sozinho — ping-pong entre
 * contas saudáveis com toasts falsos de "limite atingido". A faixa
 * header→footer só protege DURANTE o streaming; depois disso, só o texto
 * neutro salva.
 *
 * Por isso o excerpt é sanitizado NO BUILD: as formas de erro viram citação
 * marcada, ilegíveis para o detector mas legíveis para o agente. O motivo
 * na 2ª linha também precisa das máscaras quando o header sai da tela. Se um
 * padrão novo entrar no detector, a máscara correspondente entra aqui — o
 * teste anti-drift (`failover-phantom` no lado main) quebra se divergirem.
 */
const EXCERPT_TRIGGER_MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  // Códigos emoldurados (o detector exige framing http/status/error).
  // Grupo nomeado: '$<framing>4xx' preserva o framing sem a ambiguidade de '$14xx'.
  [
    /(?<framing>http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*|error\s*[:=]?\s*)40[12]\b/gi,
    '$<framing>4xx',
  ],
  [
    /(?<framing>http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*|error\s*[:=]?\s*)429\b/gi,
    '$<framing>4xx',
  ],
  [/401\s+unauthorized/gi, '4xx Unauthorized'],
  [/authentication[_\s]?error/gi, 'authentication_issue'],
  // Par combinado antes das formas isoladas: `rate limit … try again`
  // (ponte de até 24 chars no detector) recasaria mesmo mascarado em partes.
  // `rate cap` proposital: o detector casa `rate[-_\s]?limit` (o vendorado omp
  // INCLUI hífen), então a reposição precisa quebrar o token — hífen ou
  // colchete sozinhos rearmam uma das duas taxonomias.
  [
    /rate[_\s]?limit[_\s]+(?:exceeded|reached|hit)\b.{0,30}\btry again\b/gi,
    'rate cap [citado — ver motivo]',
  ],
  [
    /rate[-_\s]?limit(?:ed|_error)\b|rate[-_\s]?limit[-_\s]+(?:exceeded|reached|hit)\b|ratelimiterror/gi,
    'rate cap [citado]',
  ],
  [/too many requests/gi, '[muitas requisições — citado]'],
  [/resource[_\s]?exhausted/gi, 'resource [esgotado — citado]'],
  [/oauth access token has expired/gi, 'oauth access token [expirado — citado]'],
  [/oauth token (?:expired|revoked)/gi, 'oauth token [expirado — citado]'],
  [/refresh token (?:expired|invalid|revoked)/gi, 'refresh token [inválido — citado]'],
  [/stored token for (["'])[^"']+\1 was rejected/gi, 'stored token [rejeitado — citado]'],
  [/please run \/login/gi, 'run /login [citado]'],
  [/not logged in/gi, 'not-logged-in [citado]'],
  [/session expired/gi, 'session [expirada — citada]'],
  [/invalid[_\s]?(?:api[_\s]?key|x-api-key)/gi, 'invalid [api-key citada]'],
  [/(usage|5-hour|daily|token) limit (?:reached|exceeded|hit)/gi, '$1 limit [citado]'],
  [/quota (?:exceeded|exhausted)/gi, 'quota [esgotada — citada]'],
  [/payment required/gi, '[pagamento — citado]'],
  [/(n[aã]o autenticado|sess[aã]o expirada|token inv[aá]lido)/gi, '[$1 — citado]'],
  [/limite de (?:uso|utiliza[cç][aã]o) (?:atingido|excedido|alcan[cç]ado)/gi, '[limite de uso — citado]'],
];

export function sanitizeHandoffExcerptForDetector(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of EXCERPT_TRIGGER_MASKS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Builder do pack (F-775): motivo+janela/reset mascarados, estado da tarefa
 * (objetivo, arquivos tocados, diff --stat) e próximo passo concreto.
 * Cross-account é sempre sessão nova + este texto — nunca --resume.
 * ------------------------------------------------------------------------ */

export interface ContinuityPackInput {
  fromAccountLabel: string;
  toAccountLabel: string;
  reason: string;
  role?: string;
  missionId?: string;
  /** Truncated terminal scrollback (ANSI stripped preferred). */
  scrollbackExcerpt?: string;
  /** Short task/todo hint from orch store. */
  openWorkHint?: string;
  /** quota | rate-limit | auth | model — taxonomy of the confirmed hit. */
  limitKind?: string;
  /** Measured window label ("5 Horas", "Semanal") when known. */
  limitWindow?: string | null;
  /** Epoch ms of the measured reset, when known. */
  limitResetsAt?: number | null;
  /** Cooldown suggested by the detector / own unblock, in ms. */
  limitCooldownMs?: number | null;
  /** Objective/task of the pane. */
  taskBrief?: string;
  /** Files touched in the pane cwd (git status porcelain). */
  touchedFiles?: readonly string[];
  /** Summarized `git diff --stat` in the pane cwd. */
  diffStat?: string;
  /** Concrete next step for the replacement agent. */
  nextStep?: string;
}

const MAX_EXCERPT = 2_400;
const MAX_HINT = 600;
const MAX_TASK_BRIEF = 400;
const MAX_NEXT_STEP = 400;
const MAX_DIFF_STAT = 1_200;
const MAX_FILES_LISTED = 20;

/**
 * Packs anteriores vêm impressos no scrollback (o handoff é digitado no CLI
 * e ecoa). Sem a poda, cada ciclo de failover embutia o pack anterior e o
 * prompt crescia a cada sessão nova — um pane recém-aberto, que ainda não
 * recebeu nenhum pedido, herdava milhares de tokens.
 */
const NESTED_PACK_RE = new RegExp(
  `\\${FAILOVER_HANDOFF_HEADER}[\\s\\S]*?${FAILOVER_HANDOFF_FOOTER}`,
  'g',
);

export function stripNestedHandoffPacks(scrollback: string): string {
  return scrollback
    .replace(NESTED_PACK_RE, '[handoff anterior omitido]')
    .replace(/[ \t]{2,}/g, ' ');
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Como `clip`, mas guarda o FIM — o trecho recente do scrollback importa. */
function clipTail(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `…${t.slice(-(max - 1))}`;
}

function formatLimitLine(input: ContinuityPackInput, fromMasked: string): string {
  const parts: string[] = [];
  if (input.limitKind) parts.push(`kind ${clip(input.limitKind, 24)}`);
  const reason = sanitizeHandoffExcerptForDetector(clip(input.reason, 160));
  parts.push(reason);
  if (input.limitWindow) {
    parts.push(`window ${clip(input.limitWindow, 32)}`);
  }
  if (input.limitResetsAt != null && Number.isFinite(input.limitResetsAt)) {
    parts.push(`resets ${new Date(input.limitResetsAt).toISOString()}`);
  } else if (input.limitCooldownMs != null && Number.isFinite(input.limitCooldownMs)) {
    const mins = Math.round(input.limitCooldownMs / 60_000);
    if (mins > 0) parts.push(`cooldown ~${mins}min`);
  }
  return `Account "${fromMasked}" hit a provider limit (${parts.join('; ')}).`;
}

function clampPack(pack: string): string {
  if (pack.length <= MAX_CONTINUITY_PACK_CHARS) return pack;
  const footerAt = pack.lastIndexOf(FAILOVER_HANDOFF_FOOTER);
  const body = footerAt >= 0 ? pack.slice(0, footerAt) : pack;
  const budget = MAX_CONTINUITY_PACK_CHARS - FAILOVER_HANDOFF_FOOTER.length - 1;
  return `${body.slice(0, Math.max(0, budget))}\n${FAILOVER_HANDOFF_FOOTER}`;
}

/**
 * Build the handoff prompt injected after a fresh spawn on the replacement
 * account. Never claims native --resume succeeded across accounts.
 *
 * Rótulos de conta SEMPRE mascarados (`maskAccountLabel`) — o pack é digitado
 * no PTY e o scrollback pode ser capturado/logado; o recibo de escolha de
 * conta já opera sob a mesma regra (AGENTS.md multi-conta).
 */
export function buildContinuityPack(input: ContinuityPackInput): string {
  const role = input.role === 'orchestrator' ? 'orchestrator' : 'agent';
  const fromMasked = maskAccountLabel(input.fromAccountLabel);
  const toMasked = maskAccountLabel(input.toAccountLabel);
  const lines = [
    FAILOVER_HANDOFF_HEADER,
    formatLimitLine(input, fromMasked),
    `You are now running on account "${toMasked}" in a NEW provider session.`,
    `Terminal scrollback above is historical context only — the previous conversation id is NOT transferable across accounts.`,
    `Continue as the ${role} from the next pending step. Do not re-do completed work. Prefer files/MCP mission state over guessing.`,
  ];
  if (input.missionId) {
    lines.push(`Mission id: ${clip(input.missionId, 80)}.`);
  }
  if (input.taskBrief) {
    lines.push(
      `Task: ${sanitizeHandoffExcerptForDetector(clip(input.taskBrief, MAX_TASK_BRIEF))}`,
    );
  }
  if (input.openWorkHint) {
    lines.push(
      `Open work: ${sanitizeHandoffExcerptForDetector(clip(input.openWorkHint, MAX_HINT))}`,
    );
  }
  if (input.touchedFiles && input.touchedFiles.length > 0) {
    const files = input.touchedFiles.slice(0, MAX_FILES_LISTED).map((f) => `- ${clip(f, 120)}`);
    const more =
      input.touchedFiles.length > MAX_FILES_LISTED
        ? `\n- (+${input.touchedFiles.length - MAX_FILES_LISTED} more)`
        : '';
    lines.push(`Touched files:\n${files.join('\n')}${more}`);
  }
  if (input.diffStat) {
    lines.push(
      `Diff (stat):\n${sanitizeHandoffExcerptForDetector(clip(input.diffStat, MAX_DIFF_STAT))}`,
    );
  }
  if (input.nextStep) {
    lines.push(
      `Next step: ${sanitizeHandoffExcerptForDetector(clip(input.nextStep, MAX_NEXT_STEP))}`,
    );
  }
  if (input.scrollbackExcerpt) {
    // Sanitizado contra o limit-detector (F-511): o excerpt cita a tela da
    // morte da sessão anterior — 401/429/quota verbatim. Sem as máscaras, o
    // detector recasa esse texto citado como sinal vivo assim que o header
    // do pack sai da janela rolante (4000 chars) e o failover entra em
    // ping-pong entre contas saudáveis. O motivo na 2ª linha recebe o mesmo
    // tratamento: a TUI pode redesenhá-la sem o header.
    const excerpt = sanitizeHandoffExcerptForDetector(
      clipTail(stripNestedHandoffPacks(input.scrollbackExcerpt), MAX_EXCERPT),
    );
    lines.push(`Recent terminal excerpt (may be partial):\n"""\n${excerpt}\n"""`);
  }
  lines.push(FAILOVER_HANDOFF_FOOTER);
  return clampPack(lines.join('\n'));
}
