import { showMessageBoxWithoutBlocking } from '../native-confirm';

const CONTROL_CHARS = /[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g;
const MAX_LABEL = 140;
const MAX_DETAIL = 1_200;
const ACP_PERMISSION_TIMEOUT_MS = 120_000;

export interface AcpPermissionUiContext {
  readonly agentLabel: string;
  readonly missionId: string;
}

function safeText(value: unknown, max = MAX_LABEL): string {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cancelledOutcome(): Record<string, unknown> {
  return { outcome: { outcome: 'cancelled' } };
}

interface PermissionOption {
  readonly optionId: string;
  readonly label: string;
}

function optionsFromParams(params: Record<string, unknown> | undefined): PermissionOption[] {
  if (!Array.isArray(params?.options)) return [];
  return params.options.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const option = raw as Record<string, unknown>;
    const optionId = safeText(option.optionId);
    if (!optionId) return [];
    return [{
      optionId,
      label: safeText(option.name ?? option.kind ?? optionId),
    }];
  });
}

async function showPermissionDialog(
  params: Record<string, unknown> | undefined,
  context: AcpPermissionUiContext,
): Promise<Record<string, unknown>> {
  const options = optionsFromParams(params);
  if (options.length === 0) return cancelledOutcome();
  const tool = safeText(
    (params?.toolCall as Record<string, unknown> | undefined)?.title ??
      params?.toolName ??
      'uma ferramenta',
  );
  const detail = (
    `Agente: ${safeText(context.agentLabel)}\n` +
    `Missão: ${safeText(context.missionId)}\n` +
    `Ação: ${tool}\n\n` +
    'A permissão vale somente para esta solicitação ACP.'
  ).slice(0, MAX_DETAIL);
  // F-1200: sem janela-mãe o macOS prendia a main thread até o clique. Sheet
  // numa janela viva, fechado no mesmo prazo do race abaixo; sem janela, nega.
  const result = await showMessageBoxWithoutBlocking({
    type: 'warning',
    title: 'Nexus IDE — autorização do agente ACP',
    message: 'O agente pediu autorização para continuar.',
    detail,
    buttons: ['Negar', ...options.map((option) => option.label)],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }, { timeoutMs: ACP_PERMISSION_TIMEOUT_MS }).catch(() => null); // sem Electron: nega
  const selected = result ? options[result.response - 1] : undefined;
  return selected
    ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
    : cancelledOutcome();
}

let permissionQueue = Promise.resolve();

/** Serialize native permission dialogs and fail closed when the operator does not answer. */
export function requestAcpPermission(
  params: Record<string, unknown> | undefined,
  context: AcpPermissionUiContext,
): Promise<Record<string, unknown>> {
  const request = permissionQueue.then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        showPermissionDialog(params, context),
        new Promise<Record<string, unknown>>((resolve) => {
          timer = setTimeout(() => resolve(cancelledOutcome()), ACP_PERMISSION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  permissionQueue = request.then(() => undefined, () => undefined);
  return request;
}
