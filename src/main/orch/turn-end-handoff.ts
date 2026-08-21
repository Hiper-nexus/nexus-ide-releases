// C-194.1 no idioma do Nexus — fechamento mecânico de turno de worker.
//
// O Overclock fecha o turno do worker com um Stop hook .mjs que roda FORA do
// app e descobre o mundo por arquivos (identidade por env, origem do input por
// `input-origin-<paneId>`, dedup por varredura de transcript com poll contra a
// corrida de flush de ~83ms). O Nexus não precisa de nenhum desses rodapes: o
// Main É o dono do PTY, do gate e do store. Quando o payload de Stop chega em
// `/hook/status` (neto fail-open do hooks-gen), o Main já sabe:
//   · papel e missão da sessão (gate ctx);
//   · se o worker já chamou a tool NESTE turno (store — o commit da tool é
//     durável ANTES do resultado voltar pro CLI, então quando o Stop dispara
//     a linha já existe; sem corrida, sem poll de transcript);
//   · se o último input veio do teclado do operador (getLastSessionInputOrigin
//     — o F-339 do Overclock, já em dado);
//   · a fronteira do turno (tapAgentTurnStart; para o turno de nascimento por
//     argv não há evento, e aí a janela 0 é correta: primeiro turno de uma
//     sessão física nova não tem handoff prévio).
//
// O anti-eco (F-342) do Overclock colapsa na guarda de papel: só orquestrador
// recebe entrega de handoff, e orquestrador é skip por role. `pane_write` do
// orquestrador num worker é tarefa delegada — fechamento mecânico é o
// comportamento CORRETO ali.
//
// Semântica de entrega (1.2.3 "vitória 2", idêntica ao Overclock):
//   · resposta ≤280 chars → viaja INTEIRA no summary, verbatim;
//   · >280 chars → viaja a VERDADE (tamanho + ponteiro), nunca um corte
//     fingindo resumo; a íntegra viaja em artifacts[0].fullText (teto 60k).
//
// A submissão reusa a transação durável do PTY-stream (receipts, transição de
// dispatch, wake do orquestrador). A distinção de origem vive em
// artifacts[0].closedBy = 'turn-end' + summary prefixado '[auto]'.

import { readFileSync } from 'node:fs';
import { getContextBySession } from './gate';
import { getLastSessionInputOrigin } from '../pty/pty-manager';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  submitPtyStreamHandoff,
  terminateStaleReadOnlyPtyStreamSession,
  type PtyStreamHandoffPayload,
} from './pty-stream-handoff';
import { tapAgentTurnStart, type AgentTurnStartEntry } from './agent-status';
import type { Handoff } from '../../shared/orch-types';

/** Teto da resposta que viaja inteira (mesma régua do Overclock). */
export const MECHANICAL_HANDOFF_VERBATIM_LIMIT = 280;
/** Teto da íntegra guardada em artifacts (mesmo teto do Overclock). */
export const MECHANICAL_HANDOFF_FULLTEXT_CAP = 60_000;
/** Prefixo que marca origem mecânica no summary (o '[auto]' do Overclock). */
export const MECHANICAL_HANDOFF_MARK = '[auto]';
/** Marcador de origem dentro de artifacts[0]. */
export const MECHANICAL_HANDOFF_CLOSED_BY = 'turn-end';

// ── Turn boundary + double-fire dedup (estado por sessão física) ──────────

const turnStartBySession = new Map<string, AgentTurnStartEntry>();
const lastStopSignatureBySession = new Map<string, string>();

let turnStartTap: (() => void) | null = null;

/**
 * Liga a captura de fronteira de turno. Idempotente; chamado no init da
 * orquestração. Sem isso o dedup por turno degrada para a janela 0 (seguro —
 * pula menos, nunca duplica).
 */
export function startTurnEndHandoffClosure(): void {
  if (turnStartTap) return;
  turnStartTap = tapAgentTurnStart((entry) => {
    turnStartBySession.set(entry.sessionId, entry);
    lastStopSignatureBySession.delete(entry.sessionId);
  });
}

/** Test-only: descarta o estado por sessão. */
export function __resetTurnEndHandoffForTests(): void {
  turnStartBySession.clear();
  lastStopSignatureBySession.clear();
}

/** Test-only: injeta uma fronteira de turno. */
export function __noteTurnStartForTests(entry: AgentTurnStartEntry): void {
  turnStartBySession.set(entry.sessionId, entry);
}

// ── Colheita do texto da resposta ─────────────────────────────────────────

/**
 * Nomes de campo que carregam a última fala do agente, normalizados (minúsculo,
 * sem `-`/`_`). Cada CLI usa um dialeto: Claude Code manda
 * `last_assistant_message`, o `stop` do codex-rs manda `last_agent_message`, e
 * o notify do Codex manda `last-assistant-message` com hífen.
 */
const REPLY_TEXT_KEYS = new Set([
  'lastassistantmessage',
  'lastagentmessage',
  'promptresponse',
  'assistantmessage',
  'agentmessage',
]);

/** Envelopes onde um CLI pode aninhar o corpo do evento. */
const REPLY_ENVELOPE_KEYS = ['payload', 'data', 'turn', 'result', 'event'];

function normalizeReplyKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Texto da resposta pelo payload do hook. O Stop do Claude Code traz
 * `last_assistant_message` montado EM MEMÓRIA (imune à corrida de flush do
 * transcript — F-355); outros sabores trazem `prompt_response`,
 * `last_agent_message` (codex-rs) ou `last-assistant-message` (notify do
 * Codex). Casar só o dialeto do Claude perdia a resposta INTEIRA de todo pane
 * não-Claude: o contrato manda o worker responder e NÃO chamar ferramenta
 * quando cabe em 280 chars, então sem esta captura o texto some de vez.
 * Campo 20/08: "sem texto honesto (payload e transcript vazios)" em dois panes
 * Codex que tinham respondido `2` na tela.
 *
 * String vazia quando o payload não carrega texto.
 */
export function payloadReplyText(
  body: Record<string, unknown>,
): string {
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;
    if (!REPLY_TEXT_KEYS.has(normalizeReplyKey(key))) continue;
    const text = value.trim();
    if (text) return text;
  }
  for (const envelope of REPLY_ENVELOPE_KEYS) {
    const nested = body[envelope];
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
      continue;
    }
    const text = payloadReplyText(nested as Record<string, unknown>);
    if (text) return text;
  }
  return '';
}

function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

/**
 * Última fala do assistente num transcript JSONL, varrendo de trás pra frente
 * até a fronteira de turno (primeira entrada humana). Tolerante a shapes: o
 * ramo `type: 'assistant'` é o Claude; o fallback por `role` cobre os shapes
 * genéricos (codex/grok) sem escrever uma gramática por CLI. Resultado de
 * tool volta como entrada `user` — não é fala de humano, a varredura segue.
 */
export function readLastAssistantTextFromTranscript(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  let lines: string[];
  try {
    lines = readFile(path).split('\n');
  } catch {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = ev.message as Record<string, unknown> | undefined;
    const content = message ? message.content : ev.content ?? ev.text;
    const type = typeof ev.type === 'string' ? ev.type : '';
    const role =
      typeof message?.role === 'string'
        ? message.role
        : typeof ev.role === 'string'
          ? ev.role
          : type;
    if (type === 'assistant' || /assistant|agent/i.test(role)) {
      const text = partsToText(content);
      if (text.trim()) return text.trim();
      continue;
    }
    if (/user|human/i.test(role)) {
      const isToolResult =
        Array.isArray(content) &&
        content.length > 0 &&
        content.every(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'tool_result',
        );
      if (isToolResult || ev.isMeta === true) continue;
      break;
    }
  }
  return '';
}

/**
 * Fonte primária: payload. Degradado: transcript (o CLI pode não ter flusheado
 * a última linha no instante do Stop — corrida medida ~83ms no Overclock; o
 * Main roda desacoplado do turno, esperar aqui é grátis).
 */
export async function harvestTurnReplyText(
  body: Record<string, unknown>,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<string> {
  const fromPayload = payloadReplyText(body);
  if (fromPayload) return fromPayload;
  const transcriptPath =
    typeof body.transcript_path === 'string'
      ? body.transcript_path
      : typeof body.transcriptPath === 'string'
        ? body.transcriptPath
        : '';
  if (!transcriptPath) return '';
  const deadline = Date.now() + 2_000;
  let delay = 25;
  for (;;) {
    const text = readLastAssistantTextFromTranscript(transcriptPath);
    if (text) return text;
    if (Date.now() >= deadline) return '';
    await wait(Math.min(delay, 100));
    delay *= 2;
  }
}

// ── Corpo da entrega (regra 1.2.3) ────────────────────────────────────────

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** djb2 — identidade do turno p/ dedup de re-disparo; não é hash de segurança. */
function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export interface MechanicalHandoffInput {
  readonly replyText: string;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

export interface MechanicalHandoffPayload extends PtyStreamHandoffPayload {
  status: 'success';
}

/**
 * Regra de entrega: ≤280 viaja INTEIRA no summary (verbatim, cópia por código
 * — o modelo re-gera e parafraseia até quando cabe); >280 viaja a VERDADE +
 * ponteiro, íntegra em artifacts[0].fullText. Summary precisa de ≥20 chars
 * (summarizeForPersistence) — o enxerto "Resposta do worker:" só entra quando
 * o verbatim é curto demais para o mínimo do store.
 */
export function buildMechanicalHandoffPayload(
  input: MechanicalHandoffInput,
): MechanicalHandoffPayload {
  const flat = collapseWs(input.replyText);
  const artifacts: Record<string, unknown> = {
    auto: true,
    closedBy: MECHANICAL_HANDOFF_CLOSED_BY,
  };
  if (input.sessionId) artifacts.sessionId = input.sessionId;
  if (input.transcriptPath) artifacts.transcript = input.transcriptPath;
  let summary: string;
  if (flat.length <= MECHANICAL_HANDOFF_VERBATIM_LIMIT) {
    summary = `${MECHANICAL_HANDOFF_MARK} ${flat}`;
    if (summary.length < 20) {
      summary = `${MECHANICAL_HANDOFF_MARK} Resposta do worker: ${flat}`;
    }
  } else {
    summary =
      `${MECHANICAL_HANDOFF_MARK} concluiu — resposta longa, ${flat.length} ` +
      'chars. Íntegra em artifacts[0].fullText.';
    artifacts.fullText = input.replyText.slice(0, MECHANICAL_HANDOFF_FULLTEXT_CAP);
  }
  return {
    status: 'success',
    summary,
    artifacts: [artifacts],
  };
}

// ── Guardas (matriz pura, testável) ───────────────────────────────────────

export interface TurnEndClosureFacts {
  /** Existe gate ctx vivo para a sessão. */
  readonly hasGateContext: boolean;
  /** role === 'worker' com missão vinculada. */
  readonly isMissionWorker: boolean;
  /** Último input da sessão veio do teclado do operador (F-339). */
  readonly lastInputFromHuman: boolean;
  /** Texto honesto colhido do payload/transcript ('' = nada). */
  readonly replyText: string;
  /** Handoffs desta sessão criados dentro do turno corrente. */
  readonly handoffsSinceTurnStart: number;
  /** Este Stop é re-disparo de um já processado (mesma impressão digital). */
  readonly isRedeliveryOfProcessedStop: boolean;
  /** A consulta de dedup falhou — fail-closed: não fecha na dúvida. */
  readonly dedupUnavailable: boolean;
}

export interface TurnEndClosureDecision {
  readonly close: boolean;
  readonly reason: string;
}

/**
 * Ordem das guardas: barato primeiro; cada skip nomeado (o log é o diagnóstico
 * de campo — "por que não fechou" nunca pode ser silêncio).
 */
export function decideTurnEndClosure(
  facts: TurnEndClosureFacts,
): TurnEndClosureDecision {
  if (!facts.hasGateContext) {
    return { close: false, reason: 'sem gate ctx (sessão não agenciada)' };
  }
  if (!facts.isMissionWorker) {
    return { close: false, reason: 'não é worker de missão' };
  }
  if (facts.lastInputFromHuman) {
    return { close: false, reason: 'turno aberto pelo teclado do operador' };
  }
  if (!facts.replyText.trim()) {
    return { close: false, reason: 'sem texto honesto (payload e transcript vazios)' };
  }
  if (facts.dedupUnavailable) {
    return {
      close: false,
      reason: 'dedup indisponível (fail-closed — fechamento mecânico nunca duplica na dúvida)',
    };
  }
  // F-104 campo 21/08: NÃO existe veto "orquestrador aguarda handoff". O
  // marcador era armado no spawn e SÓ era limpo por um submit do próprio
  // worker — exatamente o que ele não fez. Vedar o fechamento nesse estado
  // lacrava o worker para sempre (sem [auto], chef-idle em loop, missão sem
  // fim). O fechamento mecânico É a resolução da espera; os guardões de dedup
  // acima (janela do turno + impressão digital do Stop) bastam contra
  // duplicação.
  if (facts.handoffsSinceTurnStart > 0) {
    return { close: false, reason: 'worker já entregou handoff neste turno' };
  }
  if (facts.isRedeliveryOfProcessedStop) {
    return { close: false, reason: 're-disparo do mesmo Stop (dedup)' };
  }
  return { close: true, reason: 'worker encerrou sem entregar — fechamento mecânico' };
}

// ── Orquestração (recolhe fatos, decide, submete) ─────────────────────────

export interface WorkerHandoffWindowProbe {
  /** Sessão física que disparou o Stop. */
  readonly sessionId: string;
  /** Encarnação exata do worker (sobrevive a rebind de sessão no turno). */
  readonly workerIncarnationId?: string;
  /** Fronteira do turno (observedAt do turn-start; 0 = turno de nascimento). */
  readonly windowStart: number;
}

/**
 * Dedup por encarnação, não só por sessão: um handoff commitado sob OUTRA
 * sessão da MESMA encarnação física (rebind/respawn no meio do turno) conta
 * como entregue. A encarnação é o nonce emitido pelo Main para o processo
 * físico exato — é a identidade que não muda quando o sessionId muda.
 */
export function countRecentWorkerHandoffs(
  handoffs: readonly Handoff[],
  probe: WorkerHandoffWindowProbe,
): number {
  return handoffs.filter((handoff) => {
    if (handoff.createdAt < probe.windowStart) return false;
    const sameSession = handoff.sessionId === probe.sessionId;
    const sameIncarnation =
      probe.workerIncarnationId !== undefined &&
      handoff.workerIncarnationId === probe.workerIncarnationId;
    return sameSession || sameIncarnation;
  }).length;
}

/**
 * Entry point: chamado pelo /hook/status quando o evento canônico é
 * `status/stop`. Fire-and-forget — nunca pode afetar a resposta HTTP nem o
 * reducer. Falhas viram log nomeado, nunca exceção pra cima.
 */
export async function handleTurnEndMechanicalHandoff(input: {
  readonly sessionId: string;
  readonly body: Record<string, unknown>;
}): Promise<void> {
  const { sessionId, body } = input;
  try {
    const replyText = await harvestTurnReplyText(body);
    const ctx = getContextBySession(sessionId);
    const transcriptPath =
      typeof body.transcript_path === 'string'
        ? body.transcript_path
        : typeof body.transcriptPath === 'string'
          ? body.transcriptPath
          : undefined;
    const turnStart = turnStartBySession.get(sessionId);
    const signature = `${turnStart?.sequence ?? 0}:${fingerprint(replyText)}`;
    const isRedelivery =
      lastStopSignatureBySession.get(sessionId) === signature;

    let handoffsSinceTurnStart = 0;
    let dedupUnavailable = false;
    if (ctx?.missionId) {
      try {
        const suite = getProjectDomainStores(ctx.scope);
        const windowStart = turnStart?.observedAt ?? 0;
        handoffsSinceTurnStart = countRecentWorkerHandoffs(
          suite.handoffs.list({ missionId: ctx.missionId, includeDelivered: true }),
          {
            sessionId,
            workerIncarnationId: ctx.workerIncarnationId,
            windowStart,
          },
        );
      } catch (error) {
        // Fail-closed (doutrina Overclock): na dúvida NÃO fecha — um turno
        // sem fechamento mecânico é recuperável; um handoff duplicado envenena
        // a fila de entrega e bloqueia a missão inteira.
        dedupUnavailable = true;
        console.warn(
          '[turn-end-handoff] dedup query falhou (fail-closed, pula fechamento):',
          error,
        );
      }
    }

    const decision = decideTurnEndClosure({
      hasGateContext: Boolean(ctx),
      isMissionWorker: Boolean(
        ctx && ctx.role === 'worker' && ctx.missionId && ctx.workerIncarnationId,
      ),
      lastInputFromHuman: getLastSessionInputOrigin(sessionId) === 'human',
      replyText,
      handoffsSinceTurnStart,
      isRedeliveryOfProcessedStop: isRedelivery,
      dedupUnavailable,
    });
    if (!decision.close) {
      console.info(
        `[turn-end-handoff] ${sessionId}: ${decision.reason}`,
      );
      return;
    }

    const payload = buildMechanicalHandoffPayload({
      replyText,
      sessionId,
      transcriptPath,
    });
    const committed = await submitPtyStreamHandoff(sessionId, payload);
    lastStopSignatureBySession.set(sessionId, signature);
    console.info(
      `[turn-end-handoff] ${sessionId}: fechado mecanicamente ` +
        `(handoff ${committed.handoffId}${committed.replayed ? ', replay' : ''})`,
    );
  } catch (error) {
    const terminated = await terminateStaleReadOnlyPtyStreamSession(
      sessionId,
      error,
    ).catch(() => false);
    console.warn(
      `[turn-end-handoff] ${sessionId}: submissão mecânica falhou` +
        (terminated ? ' (worker read-only stale → terminado)' : '') +
        ':',
      error instanceof Error ? error.message : error,
    );
  }
}
