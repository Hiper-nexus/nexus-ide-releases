// F-1396: o atalho de subagentes internos. O Maestro (Claude Code) tem a tool
// `Agent`/`Task` — subagentes in-process que rodam na MESMA sessão, todos no
// mesmo modelo. Usada para a versão inteira, ela some com o trabalho do ponto
// de vista do Nexus: sem roteamento entre LLMs, sem quadro de entregas, sem
// handoff e sem pane visível (na 0.76.241 a missão rodou com ZERO workers do
// Nexus vivos e as outras LLMs paradas). O `MAESTRO_TURN_REMINDER` já falava em
// `nexus_pane_spawn` no prompt do operador, mas nada reage no momento exato em
// que o Maestro escolhe o atalho interno.
//
// Este módulo é a decisão pura: o hook `PreToolUse` da tool de subagente
// responde `hookSpecificOutput.additionalContext` (canal já usado pela fila do
// Maestro no F-1359 e pela triagem no F-1273) — ADITIVO, nunca bloqueio. O
// subagente continua rodando; o que muda é o Maestro saber, na hora, quantos
// workers Nexus tem vivos e que o atalho do Nexus abre LLMs diferentes.
//
// Não avisa: pane que não é o Maestro da missão; leitura curta (Explore/Plan/
// claude-code-guide — responder isso não quer pane); e `model` que só existe via Agent
// (o `fable`, revisor obrigatório — pedir o atalho ali é o uso CERTO).
// NUNCA carrega o prompt: só o rótulo do subagente e o modelo, ambos rótulos.

import type { InboxNoticeContext } from './maestro-inbox-notice';

/** As duas grafias da tool de subagente (Claude Code atual e `Task` legado). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['agent', 'task']);

/**
 * Subagentes de LEITURA CURTA: respondem em uma passada e não produzem trabalho
 * que valha um pane (nem entrada no quadro). Case-insensitive.
 */
const READ_ONLY_SUBAGENTS: ReadonlySet<string> = new Set([
  'explore',
  'plan',
  'claude-code-guide',
]);

/**
 * Modelos que o Maestro só consegue pedir pelo atalho interno (F-234: o veredito
 * de frente é obrigatório, e o `fable` mora ali). Neles, usar `Agent` é o uso
 * certo — avisar seria chamar o uso errado de errado.
 */
const AGENT_ONLY_MODEL_MARK: ReadonlySet<string> = new Set(['fable']);

/** Rótulo é rótulo: teto defensivo, nunca payload. */
const LABEL_MAX = 120;

export interface AgentToolCall {
  /** `tool_input.subagent_type` normalizado; null = general-purpose implícito. */
  readonly subagentType: string | null;
  /** `tool_input.model` normalizado; null = o modelo da sessão. */
  readonly model: string | null;
}

/** Contadores e ids para o trace — nunca conteúdo de prompt. */
export interface AgentNudgeEvent {
  readonly missionId: string;
  readonly sessionId: string;
  /** Quantas vezes o aviso disparou nesta missão, contando esta. */
  readonly count: number;
  /** Workers do Nexus vivos na missão no momento do aviso. */
  readonly liveWorkers: number;
}

export interface AgentNudgeDeps {
  /**
   * Workers Nexus vivos da missão. Só é CONSULTADO quando o aviso realmente
   * vai sair — ler leitura curta, `fable` ou pane que não é o Maestro não
   * custa uma leitura de inventário.
   */
  readonly countLiveWorkers: (missionId: string) => number | Promise<number>;
  /** Test-only/observabilidade: recebe o contador por missão. */
  readonly onTrace?: (event: AgentNudgeEvent) => void;
}

const MAX_TRACKED_MISSIONS = 128;
/** missionId → quantas vezes o aviso disparou nela. */
const nudgeCountByMission = new Map<string, number>();

function label(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase().slice(0, LABEL_MAX);
  return clean.length > 0 ? clean : null;
}

/**
 * A chamada de subagente do payload `PreToolUse` do Claude Code. Qualquer outra
 * forma → null. Lê APENAS os dois rótulos: o `prompt`/`description` que o Maestro
 * escreveu não entra no retorno.
 */
export function parseAgentToolCall(body: unknown): AgentToolCall | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.hook_event_name !== 'PreToolUse') return null;
  const tool = label(record.tool_name);
  if (!tool || !SUBAGENT_TOOLS.has(tool)) return null;
  const input = record.tool_input;
  if (!input || typeof input !== 'object') return null;
  return {
    subagentType: label((input as Record<string, unknown>).subagent_type),
    model: label((input as Record<string, unknown>).model),
  };
}

/**
 * Trabalho de pane? Leitura curta não conta (e `null`, o default, conta).
 * Normaliza o rótulo aqui — quem chama não precisa saber que o Claude Code
 * escreve `Explore` com inicial maiúscula.
 */
export function isWorkSubagent(subagentType: string | null): boolean {
  if (subagentType === null) return true;
  const normalized = label(subagentType);
  return normalized === null || !READ_ONLY_SUBAGENTS.has(normalized);
}

/** O modelo só existe pelo atalho interno (revisor de frente)? */
function isAgentOnlyModel(model: string | null): boolean {
  if (!model) return false;
  return model.split(/[^a-z0-9]+/).some((token) => AGENT_ONLY_MODEL_MARK.has(token));
}

export const AGENT_NUDGE_MAX_CHARS = 600;

/**
 * A linha que entra como `additionalContext`: o número de workers Nexus vivos
 * agora e o atalho que abre LLMs diferentes. Curta de propósito — vai no meio
 * do turno do Maestro, ao lado da chamada que ele acabou de decidir.
 */
export function formatAgentNudge(liveWorkers: number): string {
  const count = Number.isFinite(liveWorkers) && liveWorkers > 0 ? Math.floor(liveWorkers) : 0;
  const workers = `${count} ${count === 1 ? 'worker vivo' : 'workers vivos'}`;
  const text =
    `[Nexus] Maestro: workers Nexus vivos agora: ${workers}. Para escrita ou revisão ` +
    'paralela use nexus_pane_spawn({ task, prompt }) — espalha entre as LLMs prontas, ' +
    'isolatedWriter para quem escreve, e a entrega volta por handoff. O subagente ' +
    'interno (Agent/Task) roda só neste modelo, dentro do seu pane, e não entra no quadro.';
  return text.length > AGENT_NUDGE_MAX_CHARS ? `${text.slice(0, AGENT_NUDGE_MAX_CHARS - 1)}…` : text;
}

function claimCount(missionId: string): number {
  // FIFO pela ordem de inserção: a missão mais antiga que ainda estiver no mapa
  // sai quando o teto é excedido (missões Mortas não renovam a entrada).
  for (const id of nudgeCountByMission.keys()) {
    if (nudgeCountByMission.size <= MAX_TRACKED_MISSIONS) break;
    nudgeCountByMission.delete(id);
  }
  const next = (nudgeCountByMission.get(missionId) ?? 0) + 1;
  nudgeCountByMission.set(missionId, next);
  return next;
}

/**
 * O texto do aviso para este `PreToolUse`, ou null quando nada deve ser dito.
 * Só o Maestro de uma missão viva fala; worker, pane do operador e leitura curta
 * ficam de fora, e o `fable` nunca é corrigido.
 *
 * A contagem de workers é o ÚLTIMO passo: ela só acontece quando o aviso sai,
 * e uma falha dela degrada para "nada a dizer" em vez de derrubar o turno.
 */
export async function maestroAgentNudge(
  ctx: Pick<InboxNoticeContext, 'role' | 'missionId' | 'sessionId'>,
  body: unknown,
  deps: AgentNudgeDeps,
): Promise<string | null> {
  if (ctx.role !== 'orchestrator' || !ctx.missionId || !ctx.sessionId) return null;
  const call = parseAgentToolCall(body);
  if (!call) return null;
  if (!isWorkSubagent(call.subagentType)) return null;
  if (isAgentOnlyModel(call.model)) return null;
  let liveWorkers: number;
  try {
    liveWorkers = await deps.countLiveWorkers(ctx.missionId);
  } catch {
    return null;
  }
  deps.onTrace?.({
    missionId: ctx.missionId,
    sessionId: ctx.sessionId,
    count: claimCount(ctx.missionId),
    liveWorkers,
  });
  return formatAgentNudge(liveWorkers);
}

/** Test-only: esquece as missões já avisadas. */
export function __resetAgentNudgeForTests(): void {
  nudgeCountByMission.clear();
}