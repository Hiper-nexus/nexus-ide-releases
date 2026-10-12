// POST /hook/triage — triagem Jev de falha de Bash nativo via hook Claude
// `PostToolUseFailure` (mesmo loopback server e bearer do gate que
// /hook/status). O hook dispara depois de um Bash com exit != 0; o Main joga
// comando + saída no `triageCommandFailure` e devolve
// `hookSpecificOutput.additionalContext` — o Claude lê o texto junto ao
// resultado da tool, no formato documentado do hook.
//
// O hook NUNCA pode atrapalhar o agente: qualquer entrada inválida, superfície
// desligada, Jev sem credencial ou exceção responde `{}` (200) — nunca 500 —
// e o comando do hook termina em `|| true`.

import type http from 'node:http';
import type { AgentGateContext } from './gate';
import {
  triageCommandFailure,
  type CommandTriage,
  type CommandTriageKind,
} from '../jev/jev-terminal-triage';
import { handleHookJsonPost } from './hook-http';
import {
  maestroInboxNotice,
  type InboxNoticeContext,
  type ListUndeliveredHandoffs,
} from './maestro-inbox-notice';

/** Mesmo teto do /hook/status — payloads de hook são metadados de evento. */
export const HOOK_TRIAGE_MAX_BODY_BYTES = 64 * 1024;

const TRIAGE_LABELS: Record<CommandTriageKind, { label: string; hint: string }> = {
  flaky: {
    label: 'falha transitória',
    hint: 'tente de novo uma vez antes de investigar',
  },
  environment: {
    label: 'ambiente da máquina',
    hint: 'verifique ferramenta, versão ou permissões antes de mexer no código',
  },
  config: {
    label: 'configuração do projeto/ferramenta',
    hint: 'revise flags, variáveis de ambiente e arquivos de config',
  },
  regression: {
    label: 'defeito real no código',
    hint: 'investigue e corrija o código, não o comando',
  },
  usage: {
    label: 'comando errado',
    hint: 'corrija o comando (typo, caminho ou argumentos)',
  },
};

/**
 * Extrai {command, exitCode, output} do payload `PostToolUseFailure` do Claude
 * (documentado: `tool_name`, `tool_input.command`, `error` cuja primeira
 * linha é `Exit code N` seguida da saída intercalada). Qualquer forma
 * inesperada → null.
 */
export function parseBashFailure(
  body: unknown,
): { command: string; exitCode: number; output: string } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const toolName = record.tool_name;
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return null;
  if (typeof record.error !== 'string') return null;
  const error = record.error;
  const firstLineBreak = error.indexOf('\n');
  const firstLine = firstLineBreak === -1 ? error : error.slice(0, firstLineBreak);
  const exitMatch = /^Exit code (\d+)/.exec(firstLine);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : 1;
  const output =
    exitMatch && firstLineBreak !== -1 ? error.slice(firstLineBreak + 1) : error;
  const toolInput = record.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawCommand = (toolInput as Record<string, unknown>).command;
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return null;
  return { command: rawCommand, exitCode, output };
}

/** Texto pt-BR curto (≤ ~400 chars) injetado como additionalContext. */
export function formatTriageContext(triage: CommandTriage): string {
  const { label, hint } = TRIAGE_LABELS[triage.kind] ?? TRIAGE_LABELS.regression;
  const retryText =
    triage.retryHelps >= 0.6 ? 'provavelmente resolve' : 'provavelmente falha igual';
  const text =
    `[Nexus · Jev] Triagem da falha: ${label} ` +
    `(confiança ${triage.confidence.toFixed(2)}). ` +
    `Repetir o mesmo comando sem mudar nada: ${retryText} ` +
    `(${triage.retryHelps.toFixed(2)}). ${hint}`;
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

export interface HookTriageDeps {
  triage?: typeof triageCommandFailure;
  signal?: AbortSignal;
  /** F-1359: fila durável do Maestro; default = store da missão. */
  listUndelivered?: ListUndeliveredHandoffs;
}

type HookTriageContext = Pick<AgentGateContext, 'sessionId'> & InboxNoticeContext;

/**
 * F-1359: o hook PostToolUse (corpo fixo, sem o payload da tool) pergunta se
 * entrou entrega na fila do Maestro ocupado. Só responde quando há aviso.
 */
function isInboxPoll(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === 'object' &&
      (body as Record<string, unknown>).hook_event_name === 'PostToolUse',
  );
}

/**
 * Uma requisição de triagem. Retorna sempre 200: `{}` quando não há o que
 * dizer (payload fora do formato, superfície off, triagem indisponível ou
 * exceção) — o hook nunca deve perturbar o Claude.
 */
export async function handleHookTriageRequest(
  ctx: HookTriageContext,
  body: unknown,
  deps: HookTriageDeps = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    if (isInboxPoll(body)) {
      const notice = maestroInboxNotice(ctx, deps.listUndelivered);
      return notice
        ? {
            statusCode: 200,
            payload: {
              hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice },
            },
          }
        : { statusCode: 200, payload: {} };
    }
    const failure = parseBashFailure(body);
    if (!failure) return { statusCode: 200, payload: {} };
    const triageFn = deps.triage ?? triageCommandFailure;
    const triage = await triageFn(failure, { signal: deps.signal });
    if (!triage) return { statusCode: 200, payload: {} };
    return {
      statusCode: 200,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: formatTriageContext(triage),
        },
      },
    };
  } catch {
    return { statusCode: 200, payload: {} };
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing (mesmo contrato do /hook/status: 401 sem bearer, 405 não-POST,
// 400 body inválido/grande).
// ---------------------------------------------------------------------------

/** Full HTTP path for POST /hook/triage. `ctx` is the bearer context resolved
 *  by the gate server (null → 401, same contract as /gate/*). */
export async function handleHookTriageHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HookTriageContext | null,
): Promise<void> {
  await handleHookJsonPost(req, res, ctx, HOOK_TRIAGE_MAX_BODY_BYTES, (body) =>
    handleHookTriageRequest(ctx!, body),
  );
}
