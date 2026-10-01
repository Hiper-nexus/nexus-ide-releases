// POST /hook/integration — portão de integração no hook PreToolUse/Bash do
// Claude (F-234). O `nexus_git_push` e o push do `nexus_mission_set_status`
// já passam pelo portão no Main; este endpoint cobre o `git push` /
// `gh pr create|merge` / `git merge … main` digitado NO BASH do pane de
// missão, que escapava de qualquer revisão.
//
// Decisão deliberada do portão (`review_required: …`) vira
// `{"decision":"block","reason":…}` — o agente continua com a instrução.
// Fora do caminho (sem missão, comando não integrador, --dry-run) e em falha
// de infraestrutura (store/git indisponível) responde `{}`: o hook nunca
// atrapalha o CLI — o portão autoritativo continua no Main.
import path from 'node:path';
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';
import { handleHookJsonPost } from './hook-http';
import { isInsidePath } from './workspace-path';
import {
  assertIntegrationReviewed,
  isIntegrationReviewRequiredError,
} from './integration-review-gate';
import { getProjectDomainStores } from './project-domain-store-registry';

/** Mesmo teto do /hook/triage — payloads de hook são metadados de evento. */
export const HOOK_INTEGRATION_MAX_BODY_BYTES = 64 * 1024;

const INTEGRATION_SEGMENT = /^\s*(git\s+push\b|gh\s+pr\s+(?:create|merge)\b|git\s+merge\b[^;&|]*\b(?:main|master)\b)/u;

/**
 * Quebra o comando em segmentos (`;`, `&&`, `||`, `|`, quebras de linha) e
 * devolve o primeiro que integra código — um `cd … && git push` não passa
 * batido. `--dry-run` no segmento não bloqueia.
 */
export function integrationCommandHit(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;\n|]/u)) {
    if (segment.includes('--dry-run')) continue;
    if (INTEGRATION_SEGMENT.test(segment)) return true;
  }
  return false;
}

function parseBashPreToolUse(
  body: unknown,
): { command: string; cwd?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const toolInput = record.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawCommand = (toolInput as Record<string, unknown>).command;
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return null;
  const rawCwd = record.cwd;
  return {
    command: rawCommand,
    ...(typeof rawCwd === 'string' && rawCwd.trim() !== ''
      ? { cwd: rawCwd }
      : {}),
  };
}

type HookContext = Pick<AgentGateContext, 'sessionId' | 'missionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope'>>;

export async function handleHookIntegrationRequest(
  ctx: HookContext,
  body: unknown,
  deps: {
    readonly signal?: AbortSignal;
    readonly storesFor?: (
      ctx: HookContext,
    ) => Pick<
      ReturnType<typeof getProjectDomainStores>,
      'missions'
    >;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  try {
    const call = parseBashPreToolUse(body);
    if (!call) return { statusCode: 200, payload: {} };
    if (!ctx.missionId || !ctx.scope) return { statusCode: 200, payload: {} };
    if (!integrationCommandHit(call.command)) {
      return { statusCode: 200, payload: {} };
    }
    // O comando roda DENTRO do checkout de execução da missão; um cwd fora
    // dele tentando integrar é bloqueio deliberado, não fail-open.
    const root = executionScopeFor({
      scope: ctx.scope,
      executionScope: ctx.executionScope,
    }).rootRealPath;
    let cwd = root;
    if (call.cwd !== undefined) {
      const resolved = path.isAbsolute(call.cwd)
        ? path.resolve(call.cwd)
        : path.resolve(root, call.cwd);
      if (!isInsidePath(root, resolved)) {
        return {
          statusCode: 200,
          payload: {
            decision: 'block',
            reason:
              'review_required: cwd fora do checkout da missão — integração ' +
              'só roda dentro do checkout de execução',
          },
        };
      }
      cwd = resolved;
    }
    const suite = (deps.storesFor ?? ((c: HookContext) => {
      if (!c.scope) throw new Error('missing scope');
      return getProjectDomainStores(c.scope);
    }))(ctx);
    assertIntegrationReviewed(suite, ctx.missionId, cwd, deps.signal);
    return { statusCode: 200, payload: {} };
  } catch (error) {
    if (isIntegrationReviewRequiredError(error)) {
      return {
        statusCode: 200,
        payload: {
          decision: 'block',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    console.warn(
      '[integration-gate] hook falhou aberto:',
      error instanceof Error ? error.message : error,
    );
    return { statusCode: 200, payload: {} };
  }
}

/** Full HTTP path for POST /hook/integration (mesmo contrato do /hook/triage). */
export async function handleHookIntegrationHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(
    req,
    res,
    ctx,
    HOOK_INTEGRATION_MAX_BODY_BYTES,
    (body) => handleHookIntegrationRequest(ctx!, body),
  );
}
