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
  let dialog: typeof import('electron').dialog | undefined;
  try {
    // Keep ACP protocol tests runnable in plain Node without importing the
    // Electron native module at module-evaluation time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dialog = (require('electron') as typeof import('electron')).dialog;
  } catch {
    return cancelledOutcome();
  }
  if (!dialog) return cancelledOutcome();

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
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Nexus IDE — autorização do agente ACP',
    message: 'O agente pediu autorização para continuar.',
    detail,
    buttons: ['Negar', ...options.map((option) => option.label)],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const selected = options[result.response - 1];
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
