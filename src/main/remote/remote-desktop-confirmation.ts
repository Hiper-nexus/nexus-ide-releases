import type { ProjectExecutionScope } from '../../shared/types';
import {
  boundedConfirmationArgs,
  boundedConfirmationLine,
} from '../orch/confirmation-format';
import type {
  McpConfirmationRequest,
} from '../orch/mcp-dispatch';
import { McpConfirmationScheduler } from '../orch/mcp-confirmation-scheduler';
import { showMessageBoxWithoutBlocking } from '../native-confirm';

const REMOTE_CONFIRMATION_TIMEOUT_MS = 7_000;
const DIALOG_CONTROL_CHARS =
  /[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g;

function safeDialogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.replace(DIALOG_CONTROL_CHARS, ' ');
  }
  if (depth >= 6) return '[bounded]';
  if (Array.isArray(value)) {
    return value.map((entry) => safeDialogValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key.replace(DIALOG_CONTROL_CHARS, ' '),
        safeDialogValue(entry, depth + 1),
      ]),
    );
  }
  return value;
}

async function showRemoteDesktopConfirmation(
  request: McpConfirmationRequest,
): Promise<boolean> {
  const command =
    typeof request.args.command === 'string'
      ? boundedConfirmationLine(
          request.args.command.replace(DIALOG_CONTROL_CHARS, ' '),
        )
      : null;
  const operation =
    request.toolName === 'remote_pane_input'
      ? 'executar um comando de alto impacto no terminal'
      : request.toolName === 'remote_approval'
        ? 'aprovar um comando de alto impacto pedido por um agente'
        : `executar ${boundedConfirmationLine(
          request.toolName.replace(DIALOG_CONTROL_CHARS, ' '),
        )}`;
  const safeArgs = safeDialogValue(request.args) as Record<string, unknown>;
  const options = {
    type: 'warning' as const,
    buttons: ['Negar', 'Permitir'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Nexus IDE — autorização do dispositivo remoto',
    message: `Um dispositivo pareado quer ${operation}.`,
    detail:
      `Workspace: ${boundedConfirmationLine(
        request.workspaceId.replace(DIALOG_CONTROL_CHARS, ' '),
      )}\n` +
      `${command ? `Comando: ${command}\n` : ''}` +
      `Motivo: ${boundedConfirmationLine(
        request.reason.replace(DIALOG_CONTROL_CHARS, ' '),
      )}\n\n` +
      `Dados (segredos ocultos):\n${boundedConfirmationArgs(safeArgs)}`,
  };
  // F-1201: o pedido vem do celular, com o operador longe da mesa. Sem
  // janela-mãe o macOS prendia a main thread (e a própria ponte remota) até um
  // clique na mesa; o prazo de 7 s nem disparava. Sheet que fecha no prazo;
  // sem janela, ou sem Electron (testes, shutdown), nega.
  const result = await showMessageBoxWithoutBlocking(options, {
    timeoutMs: REMOTE_CONFIRMATION_TIMEOUT_MS,
  }).catch(() => null);
  return result?.response === 1;
}

/**
 * Reuse the main-owned MCP scheduler contract for remote-device prompts:
 * one native modal globally, per-device queue/rate caps and fail-closed
 * overflow. The caller times out before the PWA RPC does. Importantly, the
 * scheduler's presenter keeps waiting for the real dialog to close, so a
 * timed-out/orphaned prompt can never overlap a later prompt; the sheet closes
 * itself after the same timeout, and a late click is ignored because the
 * caller already received `false`.
 */
const remoteConfirmationScheduler = new McpConfirmationScheduler(
  showRemoteDesktopConfirmation,
);

export async function requestRemoteDesktopConfirmation(input: {
  readonly confirmationSessionId: string;
  readonly scope: ProjectExecutionScope;
  readonly toolName: string;
  readonly reason: string;
  readonly args: Record<string, unknown>;
}): Promise<boolean> {
  const queued = remoteConfirmationScheduler
    .enqueue({
      source: 'ipc-renderer',
      sessionId: input.confirmationSessionId,
      workspaceId: input.scope.rootRealPath,
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      toolName: input.toolName,
      args: input.args,
      reason: input.reason,
      agentLabel: 'Nexus Remote',
    })
    .catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), REMOTE_CONFIRMATION_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([queued, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
