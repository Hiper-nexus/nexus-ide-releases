// POST /hook/permission — aprovação estruturada (PRV-02/MOB-07) no MESMO
// servidor loopback e bearer per-pane do /hook/triage. O hook PermissionRequest
// do Claude/Codex posta o payload; o Main abre um pedido no broker e segura a
// resposta até alguém decidir (card do desktop, celular) ou o prazo vencer.
//
// Regra para não piorar o desktop: só espera quando existe respondente. Sem
// card visível para o pane e sem aparelho conectado com autoridade, responde
// `{}` na hora e o diálogo da TUI segue como hoje. Toda falha (payload fora do
// formato, sessão desconhecida, exceção) também é `{}` — o hook nunca bloqueia
// a CLI por erro do Nexus.

import type http from 'node:http';
import { z } from 'zod';
import type { ApprovalProvider } from '../../shared/approval-decision';
import { summarizeApprovalInput } from '../../shared/agent-hook-listener';
import {
  approvalBroker as defaultBroker,
  approvalFingerprint,
  hasApprovalResponder,
  type ApprovalBroker,
} from '../agent-hooks/approval-broker';
import {
  approvalOptionsFor,
  permissionHookOutput,
} from '../agent-hooks/approval-decision-mapping';
import { requiresVoiceCommandConfirmation } from '../jarvis/guardrails';
import { redactSecretText } from '../../shared/secret-redaction';
import type { AgentGateContext } from './gate';
import { handleHookJsonPost } from './hook-http';
import {
  APPROVAL_WAIT_DEFAULT_SECONDS,
  APPROVAL_WAIT_MAX_SECONDS,
} from './hook-permission-command';

export const HOOK_PERMISSION_MAX_BODY_BYTES = 64 * 1024;
const APPROVAL_WAIT_MIN_SECONDS = 5;
const MAX_COMMAND_CHARS = 16 * 1024;

const PermissionRequestBody = z
  .object({
    hook_event_name: z.literal('PermissionRequest').optional(),
    tool_name: z.string().trim().min(1).max(128),
    tool_input: z.unknown().optional(),
    permission_suggestions: z.array(z.unknown()).max(32).optional(),
  })
  .passthrough();

/** Espera configurável por `NEXUS_APPROVAL_WAIT_SECONDS`, presa em [5, 170] s. */
export function approvalWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.NEXUS_APPROVAL_WAIT_SECONDS ?? '', 10);
  const seconds = Number.isFinite(raw)
    ? Math.min(APPROVAL_WAIT_MAX_SECONDS, Math.max(APPROVAL_WAIT_MIN_SECONDS, raw))
    : APPROVAL_WAIT_DEFAULT_SECONDS;
  return seconds * 1000;
}

/**
 * Textos a classificar (Claude: string; Codex: string ou argv). No argv cada
 * elemento conta sozinho — o script de `bash -lc '<script>'` só casa com os
 * padrões ancorados no início quando lido isolado — e também junto.
 */
function shellCommandTexts(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command === 'string') return [command.slice(0, MAX_COMMAND_CHARS)];
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    const parts = command as string[];
    return [...parts, parts.join(' ')].map((text) => text.slice(0, MAX_COMMAND_CHARS));
  }
  return [];
}

/**
 * Alto impacto = o mesmo classificador do input remoto (Jarvis guardrails),
 * linha a linha sobre o comando INTEIRO (o resumo do card é cortado em 200).
 * Aprovar isso de um aparelho continua pedindo o diálogo do desktop.
 */
export function isHighImpactApproval(toolInput: unknown): boolean {
  return shellCommandTexts(toolInput)
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => requiresVoiceCommandConfirmation(line));
}

export interface HookPermissionDeps {
  provider: ApprovalProvider;
  broker?: ApprovalBroker;
  hasResponder?: (sessionId: string) => boolean;
  waitMs?: number;
  /** Abortado quando o hook (curl) desiste: o pedido fecha junto. */
  signal?: AbortSignal;
}

type PermissionResult = { statusCode: 200; payload: Record<string, unknown> };
const NO_DECISION: PermissionResult = { statusCode: 200, payload: {} };

export async function handleHookPermissionRequest(
  ctx: Pick<AgentGateContext, 'sessionId'>,
  body: unknown,
  deps: HookPermissionDeps,
): Promise<PermissionResult> {
  try {
    const sessionId = ctx.sessionId;
    if (!sessionId || deps.signal?.aborted) return NO_DECISION;
    const parsed = PermissionRequestBody.safeParse(body);
    if (!parsed.success) return NO_DECISION;
    const hasResponder = deps.hasResponder ?? hasApprovalResponder;
    if (!hasResponder(sessionId)) return NO_DECISION;
    const { tool_name: toolName, tool_input: toolInput, permission_suggestions: suggestions } = parsed.data;
    const request = { toolName, permissionSuggestions: suggestions };
    const opened = (deps.broker ?? defaultBroker).open({
      sessionId,
      provider: deps.provider,
      tool: toolName,
      // O resumo sai do desktop (card, celular): segredo conhecido vira máscara.
      summary: redactSecretText(summarizeApprovalInput(toolInput)).text,
      options: approvalOptionsFor(deps.provider, request),
      waitMs: deps.waitMs ?? approvalWaitMs(),
      fingerprint: approvalFingerprint(toolName, toolInput),
      highImpact: isHighImpactApproval(toolInput),
    });
    if (!opened) return NO_DECISION;
    const onAbort = () => opened.cancel();
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const decision = await opened.decision;
      if (!decision) return NO_DECISION;
      return { statusCode: 200, payload: permissionHookOutput(deps.provider, decision, request) };
    } finally {
      deps.signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return NO_DECISION;
  }
}

/** Mesmo contrato HTTP do /hook/triage: 401 sem bearer, 405, 400 corpo inválido. */
export async function handleHookPermissionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Pick<AgentGateContext, 'sessionId'> | null,
): Promise<void> {
  const abort = new AbortController();
  // Conexão caiu antes da resposta (curl no prazo, CLI encerrada): o pedido
  // fecha e some do card. Depois do `end`, `close` é só o fim normal.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  const provider: ApprovalProvider =
    req.headers['x-nexus-approval-provider'] === 'codex' ? 'codex' : 'claude';
  await handleHookJsonPost(req, res, ctx, HOOK_PERMISSION_MAX_BODY_BYTES, (body) =>
    handleHookPermissionRequest(ctx!, body, { provider, signal: abort.signal }),
  );
}
