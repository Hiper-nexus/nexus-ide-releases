// POST /hook/status — semantic agent-status ingest on the EXISTING embedded
// gate server (no second HTTP server). Auth is the same per-pane bearer the
// gate mints at spawn (NEXUS_GATE_TOKEN), so the token alone identifies the
// pane; hook commands (vendored emdash builders) reference $NEXUS_HOOK_URL +
// $NEXUS_GATE_TOKEN from the PTY env and never persist a secret on disk.
//
// Pipeline: zod-validate envelope → parse raw payload by CLI flavor into a
// CanonicalHookEvent (vendored emdash parsers) → fold into the semantic
// status reducer → 200. The hook channel is ADDITIVE and fail-closed: a
// reducer failure returns 500 but must never break the gate (the /gate/*
// routes — the handoff spool probe since F-1154 — live on the same server and
// are unaffected).

import type http from 'node:http';
import { z } from 'zod';
import {
  parseFlavorHookEvent,
  type NexusHookFlavor,
} from '../../vendor/emdash/hooks/flavors';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';
import { isCurrentGateContext, type AgentGateContext } from './gate';
import {
  getSessionProviderConversation,
  recordAuthenticatedNativeArgvSubmission,
} from '../pty/pty-manager';
import {
  applyCanonicalHookEvent,
  type AgentStatusApplyResult,
  type AgentStatusHookMeta,
} from './agent-status';
import { handleTurnEndMechanicalHandoff } from './turn-end-handoff';
import {
  approvalBroker,
  approvalFingerprint,
  type ApprovalBroker,
} from '../agent-hooks/approval-broker';
import { HOOK_JSON_CONTENT_TYPE } from './hook-http';
import {
  isShellHttpCommand,
  normalizeSkillName,
  observerToolKind,
} from './observer-tool-kind';
import { hookBodyMayCarryEdit, recordHookEditProvenance } from './hook-edit-provenance';

/** Turn-end callback seam — the default runs the mechanical handoff closure. */
export type TurnEndHook = (input: {
  readonly sessionId: string;
  readonly body: Record<string, unknown>;
}) => void;

/** Hook payloads are CLI event metadata. Codex Stop stdin carries
 *  `last_agent_message` (up to the 60k mechanical fullText cap) plus cwd /
 *  transcript_path; 16 KB 400'd that POST and skipped turn-end entirely. */
export const HOOK_STATUS_MAX_BODY_BYTES = 64 * 1024;
/**
 * F-1237: o PostToolUse de uma edição carrega o conteúdo escrito (Write,
 * patch do Codex) e passa dos 64 KB num arquivo grande. Só a proveniência lê
 * além do teto do status; o status desse corpo continua recusado (400).
 * F-1240: teto de 1 MB (era 4 MB) — qualquer filho do pane tem o bearer.
 */
export const HOOK_EDIT_PROVENANCE_MAX_BODY_BYTES = 1024 * 1024;
/** F-1240: começo do corpo que decide, ao passar dos 64 KB, se é edição. */
export const HOOK_EDIT_HEAD_BYTES = 8 * 1024;

export const HOOK_STATUS_FLAVORS = [
  'claude',
  'codex',
  'kimi',
  'grok',
  'default',
] as const;
export type HookStatusFlavor = (typeof HOOK_STATUS_FLAVORS)[number];

const hookStatusEnvelopeSchema = z
  .object({
    eventType: z.string().min(1).max(64),
    flavor: z.enum(HOOK_STATUS_FLAVORS).default('default'),
    body: z.record(z.string(), z.unknown()),
  })
  .strict();

export type HookStatusEnvelope = z.infer<typeof hookStatusEnvelopeSchema>;

export type HookStatusHandlerResult =
  | {
      statusCode: 200;
      payload: {
        ok: true;
        applied: boolean;
        transitioned: boolean;
        status: string | null;
        event: CanonicalHookEvent['kind'];
        authorizesEvidence: false;
      };
    }
  | { statusCode: 400; payload: { ok: false; error: string } }
  | { statusCode: 500; payload: { ok: false; error: string } };

type ApplyEventFn = (input: {
  sessionId: string;
  event: CanonicalHookEvent;
  /** Raw envelope metadata consumed only by observer-frame emission. */
  hook?: AgentStatusHookMeta;
}) => AgentStatusApplyResult;

/** Tool names are labels, not payloads — cap defensively. */
export const HOOK_TOOL_NAME_MAX_LENGTH = 120;

/**
 * Extract the tool name from a raw hook body. Mirrors the key set the
 * vendored emdash parser probes (tool_name / toolName / name / tool.name)
 * so observer tool frames agree with the canonical interactive-tool
 * classification. Returns undefined — never a fabricated name.
 */
export function extractHookToolName(
  body: Record<string, unknown>,
): string | undefined {
  const nested = body.tool;
  const candidate =
    body.tool_name ??
    body.toolName ??
    body.name ??
    (nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>).name
      : undefined);
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim().slice(0, HOOK_TOOL_NAME_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

const HOOK_TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool-use',
  'tool-complete',
  'tool-use-failure',
]);

/** Objeto de argumentos da tool no corpo cru (tool_input / toolInput / input). */
function hookToolInput(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidate = body.tool_input ?? body.toolInput ?? body.input;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

/**
 * F-780 (complemento): os DOIS rótulos que a telemetria tira dos argumentos
 * da tool, no momento do hook e sem guardar argumento nenhum:
 * - `skillName`: a skill chamada pela tool `Skill` (nome validado);
 * - `toolKind: 'shell-http'`: shell cujo comando começa com curl/wget.
 * Fora dos eventos de tool, ou sem tool identificada, devolve vazio.
 */
export function extractHookToolLabels(
  eventType: string,
  toolName: string | undefined,
  body: Record<string, unknown>,
): { skillName?: string; toolKind?: 'shell-http' } {
  if (!toolName || !HOOK_TOOL_EVENT_TYPES.has(eventType)) return {};
  const kind = observerToolKind(toolName);
  if (kind === 'skill') {
    const skillName = normalizeSkillName(hookToolInput(body)?.skill);
    return skillName ? { skillName } : {};
  }
  if (kind === 'execute') {
    const input = hookToolInput(body);
    const command = input?.command ?? input?.cmd ?? input?.CommandLine;
    return isShellHttpCommand(command) ? { toolKind: 'shell-http' } : {};
  }
  return {};
}

const APPROVAL_TOOL_DONE_EVENTS: ReadonlySet<string> = new Set(['tool-complete', 'tool-use-failure']);
const APPROVAL_TURN_EVENTS: ReadonlySet<string> = new Set(['stop', 'stop-failure', 'user-submit']);

/**
 * PRV-02: a sonda provou que a tecla do operador na TUI vence o hook
 * PermissionRequest, que segue vivo até o prazo. O PostToolUse da MESMA
 * ferramenta/argumentos, ou o fim do turno / prompt novo, prova que o diálogo
 * já foi respondido: o pedido some do card em vez de esperar o prazo.
 */
export function supersedeApprovalsForHookEvent(
  sessionId: string,
  eventType: string,
  body: Record<string, unknown>,
  broker: ApprovalBroker = approvalBroker,
): number {
  if (APPROVAL_TURN_EVENTS.has(eventType)) return broker.supersede(sessionId);
  if (!APPROVAL_TOOL_DONE_EVENTS.has(eventType)) return 0;
  const toolName = extractHookToolName(body);
  if (!toolName) return 0;
  return broker.supersede(sessionId, approvalFingerprint(toolName, body.tool_input));
}

/**
 * Handle one validated hook POST. `applyEvent` is injectable so tests can
 * prove the fail-closed contract (reducer throws → 500, gate unaffected).
 */
export function handleHookStatusRequest(
  ctx: Pick<AgentGateContext, 'sessionId'> & Partial<AgentGateContext>,
  rawEnvelope: unknown,
  applyEvent: ApplyEventFn = applyCanonicalHookEvent,
  onTurnEnd: TurnEndHook = (input) => {
    void handleTurnEndMechanicalHandoff(input);
  },
  recordEdit: typeof recordHookEditProvenance = recordHookEditProvenance,
): HookStatusHandlerResult {
  const parsed = hookStatusEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) {
    return {
      statusCode: 400,
      payload: { ok: false, error: 'invalid hook status envelope' },
    };
  }
  const { eventType, flavor, body } = parsed.data;

  let event: CanonicalHookEvent;
  try {
    event = parseFlavorHookEvent(flavor as NexusHookFlavor | 'default', eventType, body);
  } catch {
    return {
      statusCode: 400,
      payload: { ok: false, error: 'hook payload could not be parsed' },
    };
  }

  // The bearer token binds the pane; without a live PTY binding (spawn race,
  // pane already gone) the event is valid but has nowhere to land.
  if (!ctx.sessionId) {
    return {
      statusCode: 200,
      payload: {
        ok: true,
        applied: false,
        transitioned: false,
        status: null,
        event: event.kind,
        authorizesEvidence: false,
      },
    };
  }

  try {
    supersedeApprovalsForHookEvent(ctx.sessionId, eventType, body);
  } catch {
    // Aditivo: o broker nunca derruba o canal de status.
  }

  try {
    // F-1237: edição da própria conversa vira proveniência durável.
    recordEdit(ctx, eventType, body);
  } catch {
    // Aditivo: o registro nunca derruba o canal de status.
  }

  try {
    const toolName = extractHookToolName(body);
    const result = applyEvent({
      sessionId: ctx.sessionId,
      event,
      // Observer-frame emission needs the wire event type + tool name the
      // canonical event intentionally drops (additive; reducer ignores it).
      hook: { eventType, toolName, ...extractHookToolLabels(eventType, toolName, body) },
    });
    // F-1139: only the exact live bearer and an applied native prompt event
    // can satisfy the launch receipt. The raw text is hashed transiently.
    if (result.applied && event.kind === 'status' && event.type === 'start' &&
        event.promptSubmitted === true && ctx.token && isCurrentGateContext(ctx as AgentGateContext)) {
      recordAuthenticatedNativeArgvSubmission(ctx.sessionId, body.prompt);
    }
    // C-194.1: o turno do worker acabou. Quem garante que a resposta chega ao
    // orquestrador quando ele NÃO chamou a tool é o fechamento mecânico —
    // fire-and-forget, nunca no caminho da resposta HTTP nem do reducer.
    // F-734: StopFailure não é resposta — o corpo dele é texto de erro do
    // provedor (pode trazer sufixo de chave) e nunca vira handoff `[auto]`.
    if (
      event.kind === 'status' &&
      event.type === 'stop' &&
      event.stopFailure === undefined &&
      ctx.sessionId
    ) {
      onTurnEnd({ sessionId: ctx.sessionId, body });
    }
    return {
      statusCode: 200,
      payload: {
        ok: true,
        applied: result.applied,
        transitioned: result.transitioned,
        status: result.entry?.status ?? null,
        event: event.kind,
        authorizesEvidence: false,
      },
    };
  } catch (err) {
    // Fail-closed: the hook channel must never take the gate down with it.
    console.warn('[hook-status] reducer escaped (fail-closed 500):', err);
    return {
      statusCode: 500,
      payload: { ok: false, error: 'hook status reducer failed' },
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing (kept in this module so it is testable without booting the
// whole MCP server graph; mcp-server only forwards req/res + the bearer ctx).
// ---------------------------------------------------------------------------

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': HOOK_JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** F-1240: sessões com um corpo de edição acima do teto do status em leitura. */
const bigBodySessions = new Set<string>();

/**
 * Lê o corpo até 64 KB. Passou disso, decide NA HORA, pelos primeiros 8 KB e
 * sem guardar mais nada, se segue lendo (F-1240): só um PostToolUse de edição
 * (`bigBodySession`: pane com conversa vinculada), um por sessão de cada vez,
 * até 1 MB. O resto recebe 400 sem que o Main bufferize o corpo.
 */
function readHookStatusBody(
  req: http.IncomingMessage,
  bigBodySession: string | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let holdsBigSlot = false;
    let settled = false;
    let chunks: Buffer[] = [];
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (holdsBigSlot && bigBodySession) bigBodySessions.delete(bigBodySession);
      const body = error ? null : Buffer.concat(chunks);
      chunks = [];
      if (body) resolve(body);
      else reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > HOOK_STATUS_MAX_BODY_BYTES && !holdsBigSlot) {
        const head = Buffer.concat([...chunks, chunk], Math.min(size, HOOK_EDIT_HEAD_BYTES)).toString('utf8');
        if (!bigBodySession || bigBodySessions.has(bigBodySession) || !hookBodyMayCarryEdit(head)) {
          // Reject WITHOUT destroying the socket so the handler can still
          // flush a 400 (destroy-then-respond races and the client sees a
          // dropped connection instead of the validation error).
          settle(new Error('body-too-large'));
          return;
        }
        bigBodySessions.add(bigBodySession);
        holdsBigSlot = true;
      }
      if (size > HOOK_EDIT_PROVENANCE_MAX_BODY_BYTES) {
        settle(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(null));
    req.on('error', (error) => settle(error));
    // Cliente que desiste no meio não segura a vaga do corpo grande.
    req.on('close', () => settle(new Error('closed')));
  });
}

/**
 * Full HTTP path for POST /hook/status. `ctx` is the bearer context resolved
 * by the gate server (null → 401, same contract as /gate/*). Event type and
 * CLI flavor travel as headers; the raw CLI hook payload is the JSON body.
 */
export async function handleHookStatusHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Pick<AgentGateContext, 'sessionId'> & Partial<AgentGateContext> | null,
  applyEvent?: ApplyEventFn,
): Promise<void> {
  if (!ctx) {
    sendJson(res, 401, { ok: false, error: 'missing or unknown bearer token' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  const eventType = req.headers['x-nexus-hook-event'];
  const flavor = req.headers['x-nexus-hook-flavor'];
  // F-1240: corpo acima do teto do status só para o PostToolUse de um pane
  // com conversa vinculada (o único que grava proveniência).
  const bigBodySession =
    eventType === 'tool-complete' && ctx.sessionId && getSessionProviderConversation(ctx.sessionId)
      ? ctx.sessionId
      : null;
  let bytes: Buffer;
  try {
    bytes = await readHookStatusBody(req, bigBodySession);
  } catch {
    // Early response: the unread remainder of an oversized body may still be
    // in flight, so close the connection once the 400 has been flushed.
    const bodyOut = JSON.stringify({ ok: false, error: 'hook payload too large' });
    res.writeHead(400, {
      'content-type': HOOK_JSON_CONTENT_TYPE,
      'content-length': Buffer.byteLength(bodyOut),
      connection: 'close',
    });
    res.end(bodyOut, () => req.destroy());
    return;
  }

  if (bytes.length > HOOK_STATUS_MAX_BODY_BYTES) {
    // Acima do teto do status só chega uma edição grande (o começo do corpo
    // disse a ferramenta): grava a proveniência; o status segue recusando o
    // corpo, como antes.
    try {
      const big: unknown = JSON.parse(bytes.toString('utf8'));
      if (big && typeof big === 'object' && !Array.isArray(big)) {
        recordHookEditProvenance(ctx, 'tool-complete', big as Record<string, unknown>);
      }
    } catch {
      // corpo inválido: sem proveniência
    }
    sendJson(res, 400, { ok: false, error: 'hook payload too large' });
    return;
  }

  const raw = bytes.toString('utf8');
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid hook payload JSON' });
    return;
  }

  const result = handleHookStatusRequest(
    ctx,
    {
      eventType: typeof eventType === 'string' ? eventType : undefined,
      flavor: typeof flavor === 'string' ? flavor : undefined,
      body,
    },
    applyEvent,
  );
  sendJson(res, result.statusCode, result.payload);
}
