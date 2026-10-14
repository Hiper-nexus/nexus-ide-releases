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
 *
 * F-999: o pack é seguro POR CONSTRUÇÃO — todo texto citado que entra nele
 * (motivo, tarefa, arquivos, diff, próximo passo, cauda do terminal) passa
 * pelo redator de segredos e pela neutralização de sinais de limite aqui
 * dentro, seja qual for o chamador (Main ou renderer).
 */

import { maskAccountLabel } from './account-choice';
import {
  CODEX_CHATGPT_MODEL_REJECTION,
  neutralizeLimitSignals,
} from './limit-signal-patterns';
import { redactTerminalText } from './secret-redaction';

export { CODEX_CHATGPT_MODEL_REJECTION };

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
 * Frases de login/sessão que o portão de continuidade do renderer
 * (`cliAcceptsContinuityPrompt`) procura na tela: citadas no eco de um pack,
 * fariam um pane sadio parecer parado no login. Sinais de LIMITE não entram
 * aqui: a neutralização usa a fonte única do detector
 * (`neutralizeLimitSignals`). As máscaras paralelas antigas mutilavam
 * identificadores em prosa (RateLimitError → "rate cap [citado]") e deixavam
 * passar formatos como model_not_found (F-999).
 */
const CONTINUITY_GATE_MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/please run \/login/gi, 'run /login [citado]'],
  [/not logged in/gi, 'not-logged-in [citado]'],
  [/oauth access token has expired/gi, 'oauth access token [expirado — citado]'],
  [/re-authenticate to continue/gi, 're-authenticate [citado]'],
];

/**
 * Espelho de citação dos gatilhos de `limit-detector.ts` (F-511/F-999).
 *
 * O detector varre uma janela rolante de 4000 chars: quando o header do pack
 * sai da janela mas o texto citado ainda está nela, o erro CITADO da sessão
 * morta casaria como sinal vivo e o failover re-dispararia sozinho —
 * ping-pong entre contas saudáveis, ou a quarentena do modelo ATUAL. A faixa
 * header→footer só protege DURANTE o streaming; depois disso, só o texto
 * neutro salva. Aqui: frases do portão de login mascaradas, marcas de pack
 * antigo trocadas (a faixa do pack novo segue contígua) e todo sinal que o
 * detector reconhece quebrado por um caractere visível, em qualquer janela —
 * legível para o agente, inerte para o detector. Não redige segredos (ver
 * `sanitizeHandoffHistoryText`). Idempotente.
 */
export function sanitizeHandoffExcerptForDetector(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of CONTINUITY_GATE_MASKS) {
    out = out.replace(pattern, replacement);
  }
  return neutralizeLimitSignals(
    out
      .replaceAll(FAILOVER_HANDOFF_HEADER, '[handoff anterior]')
      .replaceAll(FAILOVER_HANDOFF_FOOTER, '[fim do handoff anterior]'),
  );
}

/**
 * Histórico citado pronto para um prompt (pack, recorte ORC-05): segredos
 * redigidos com o texto ainda em linhas — a chave partida pela quebra da TUI
 * só é reconhecida assim — e depois neutralizado. `tail`: cauda de terminal —
 * a 1ª linha pode começar no meio de um token e packs aninhados saem.
 */
export function sanitizeHandoffHistoryText(
  raw: string,
  options: { readonly tail?: boolean } = {},
): string {
  const redacted = redactTerminalText(raw, { partialHead: options.tail === true });
  return sanitizeHandoffExcerptForDetector(
    options.tail ? stripNestedHandoffPacks(redacted) : redacted,
  );
}

/* ------------------------------------------------------------------------ *
 * Builder do pack (F-775): motivo+janela/reset mascarados, estado da tarefa
 * (objetivo, arquivos tocados, diff --stat) e próximo passo concreto.
 * Cross-account sem histórico compartilhado é sessão nova + este texto; com
 * histórico compartilhado (F-1473) o pack é o fallback do resume nativo.
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
  /**
   * F-1482: last request(s) delivered to the pane (brief, pane write, operator
   * direction, handoff) — re-delivered so the switch never drops the ask.
   */
  inFlightRequest?: string;
  /** Files touched in the pane cwd (git status porcelain). */
  touchedFiles?: readonly string[];
  /** Summarized `git diff --stat` in the pane cwd. */
  diffStat?: string;
  /** Concrete next step for the replacement agent. */
  nextStep?: string;
  /**
   * F-775: CLI whose accounts all ran out — the task moves to ANOTHER CLI
   * (chosen by the spawn route after this text is built), not another account.
   */
  fromAdapterLabel?: string;
}

const MAX_EXCERPT = 2_400;
const MAX_HINT = 600;
const MAX_TASK_BRIEF = 400;
/**
 * F-1482: teto do pedido em voo no pack e na nota. Quem monta o texto
 * (`inFlightRequestOf`) põe o MAIS RECENTE primeiro, então o corte do fim
 * (`quoted`) só tira os anteriores.
 */
export const MAX_IN_FLIGHT_REQUEST_CHARS = 1_500;
const MAX_IN_FLIGHT = MAX_IN_FLIGHT_REQUEST_CHARS;
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

/**
 * Campo de texto livre do pack (F-999): redigido com as linhas ainda inteiras,
 * achatado e cortado, e só então neutralizado — neutralizar antes de achatar
 * deixava "quota⏎exceeded" virar "quota exceeded" depois.
 */
function quoted(raw: string, max: number): string {
  return sanitizeHandoffExcerptForDetector(clip(redactTerminalText(raw), max));
}

function formatLimitLine(input: ContinuityPackInput, fromMasked: string): string {
  const parts: string[] = [];
  if (input.limitKind) parts.push(`kind ${quoted(input.limitKind, 24)}`);
  // F-999: o motivo cru (model_not_found, insufficient_quota…) disparava numa
  // janela que começa no meio desta linha — a remoção da linha F-511 inteira
  // no detector não cobre isso. Neutralizado aqui, vale para todo chamador.
  parts.push(quoted(input.reason, 160));
  if (input.limitWindow) {
    parts.push(`window ${quoted(input.limitWindow, 32)}`);
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
 * conta já opera sob a mesma regra (AGENTS.md multi-conta). Todo outro texto
 * vindo do chamador passa por `quoted` (segredo redigido, sinal neutralizado).
 */
export function buildContinuityPack(input: ContinuityPackInput): string {
  const role = input.role === 'orchestrator' ? 'orchestrator' : 'agent';
  const fromMasked = maskAccountLabel(input.fromAccountLabel);
  const toMasked = maskAccountLabel(input.toAccountLabel);
  const lines = [
    FAILOVER_HANDOFF_HEADER,
    formatLimitLine(input, fromMasked),
    ...(input.fromAdapterLabel
      ? [
          // F-775: troca de CLI — o destino é escolhido pela rota depois.
          `No ${quoted(input.fromAdapterLabel, 40)} account can take more work right now, so this task moved to another CLI in a NEW session.`,
          `The previous conversation is NOT transferable — the touched files and the diff below are the real state of the work.`,
        ]
      : [
          `You are now running on account "${toMasked}" in a NEW provider session.`,
          `Terminal scrollback above is historical context only — the previous conversation id is NOT transferable across accounts.`,
        ]),
    `Continue as the ${role} from the next pending step. Do not re-do completed work. Prefer files/MCP mission state over guessing.`,
  ];
  if (input.missionId) {
    lines.push(`Mission id: ${quoted(input.missionId, 80)}.`);
  }
  if (input.taskBrief) {
    lines.push(`Task: ${quoted(input.taskBrief, MAX_TASK_BRIEF)}`);
  }
  if (input.openWorkHint) {
    lines.push(`Open work: ${quoted(input.openWorkHint, MAX_HINT)}`);
  }
  if (input.inFlightRequest?.trim()) {
    lines.push(
      `Request in flight (last delivered to this pane; finish it if it is not done): ${quoted(input.inFlightRequest, MAX_IN_FLIGHT)}`,
    );
  }
  if (input.touchedFiles && input.touchedFiles.length > 0) {
    const files = input.touchedFiles.slice(0, MAX_FILES_LISTED).map((f) => `- ${quoted(f, 120)}`);
    const more =
      input.touchedFiles.length > MAX_FILES_LISTED
        ? `\n- (+${input.touchedFiles.length - MAX_FILES_LISTED} more)`
        : '';
    lines.push(`Touched files:\n${files.join('\n')}${more}`);
  }
  if (input.diffStat) {
    lines.push(`Diff (stat):\n${quoted(input.diffStat, MAX_DIFF_STAT)}`);
  }
  if (input.nextStep) {
    lines.push(`Next step: ${quoted(input.nextStep, MAX_NEXT_STEP)}`);
  }
  if (input.scrollbackExcerpt) {
    // F-511/F-999: o excerpt cita a tela da morte da sessão anterior —
    // 401/429/quota/model_not_found verbatim e, num `cat .env`, chaves. A
    // cauda é redigida AINDA em linhas (chave partida pela TUI, cauda cortada
    // no meio de um token), packs aninhados saem, e só então ela é cortada e
    // neutralizada: o texto citado não re-arma o detector quando o header sai
    // da janela rolante (4000 chars) e nenhum segredo sai no pack, venha o
    // excerpt do xterm (renderer) ou do PTY (Main).
    const redacted = redactTerminalText(input.scrollbackExcerpt, { partialHead: true });
    const excerpt = sanitizeHandoffExcerptForDetector(
      clipTail(stripNestedHandoffPacks(redacted), MAX_EXCERPT),
    );
    lines.push(`Recent terminal excerpt (may be partial):\n"""\n${excerpt}\n"""`);
  }
  lines.push(FAILOVER_HANDOFF_FOOTER);
  return clampPack(lines.join('\n'));
}

export interface CrossAccountResumeNoteInput {
  toAccountLabel: string;
  role?: string;
  /** Pedido em voo da tarefa, quando quem troca a conta o conhece. */
  inFlightRequest?: string;
}

/**
 * F-1473: primeira mensagem quando a troca de conta RETOMA a conversa nativa
 * (`nativeResumeAcrossAccounts`). O histórico inteiro já está na sessão
 * retomada, então vai só esta nota — nunca o pack. Mesma faixa header→footer
 * (o detector a ignora) e o pedido citado passa por `quoted`.
 */
export function buildCrossAccountResumeNote(input: CrossAccountResumeNoteInput): string {
  const role = input.role === 'orchestrator' ? 'orchestrator' : 'agent';
  const lines = [
    FAILOVER_HANDOFF_HEADER,
    `Nexus moved this pane to account "${maskAccountLabel(input.toAccountLabel)}" because the previous account ran out of usage, and resumed THIS SAME conversation.`,
    `Continue as the ${role} exactly where you stopped. Do not re-do completed work.`,
  ];
  if (input.inFlightRequest?.trim()) {
    lines.push(`Request in flight: ${quoted(input.inFlightRequest, MAX_IN_FLIGHT)}`);
  }
  lines.push(FAILOVER_HANDOFF_FOOTER);
  return lines.join('\n');
}
