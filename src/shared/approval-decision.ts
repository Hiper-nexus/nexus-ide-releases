// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Effect Schema →
// TypeScript sem dependência (o preload sandboxed e o app móvel importam este
// arquivo em runtime); sem `acceptAlways` (nenhuma CLI em PTY o aceita pelo
// hook); envelope do pedido pendente do broker (requestId, revision,
// responseCapability, opção que degrada) e parser do `interactivePrompt`.
//
// Contrato da aprovação estruturada (PRV-02/MOB-07): o hook PermissionRequest
// do Claude/Codex espera no Main, e quem responde (card do desktop, celular)
// manda uma DECISÃO, nunca uma tecla no PTY.

/** `ProviderApprovalDecision` do T3 (packages/contracts/src/providerPolicy.ts). */
export const APPROVAL_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

export type ApprovalProvider = 'claude' | 'codex';

/**
 * Opção do card. O `optionId` é a própria decisão (o T3 manda preservar o id
 * nativo, não o rótulo). `degradesTo` existe quando a CLI não honra a opção
 * como pedida e o host responde com outra — o card precisa dizer isso.
 */
export type ApprovalOption = {
  readonly optionId: ApprovalDecision;
  readonly degradesTo?: 'accept';
};

/**
 * Só um pedido `live` ainda tem uma CLI esperando a resposta (o card do T3 só
 * habilita os botões nesse caso). `closed` = respondido, expirado ou a TUI
 * respondeu primeiro.
 */
export type ApprovalResponseCapability = 'live' | 'closed';

export type PendingApprovalEnvelope = {
  readonly requestId: string;
  /** Compare-and-set: a revisão que o cliente tinha na tela. */
  readonly revision: number;
  readonly tool: string;
  readonly summary: string;
  readonly options: readonly ApprovalOption[];
  readonly responseCapability: ApprovalResponseCapability;
};

/** Visão do desktop: o envelope mais a sessão PTY (o renderer acha o pane por ela). */
export type ApprovalRequestView = PendingApprovalEnvelope & {
  readonly sessionId: string;
  readonly provider: ApprovalProvider;
  readonly expiresAt: number;
};

export const APPROVAL_REQUEST_ID_MAX_CHARS = 128;
const MAX_TOOL_CHARS = 128;
const MAX_SUMMARY_CHARS = 400;

/** Rótulos pt-BR do card do desktop e do Nexus Remote. */
export const APPROVAL_OPTION_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  accept: 'Permitir',
  acceptForSession: 'Permitir na sessão',
  decline: 'Negar',
  cancel: 'Negar e parar',
};

export const APPROVAL_DEGRADED_NOTE =
  'Esta CLI não guarda a permissão para a sessão pelo hook: vale só para este pedido.';

/** `{ approval: {...} }` — o mesmo envelope que o hook listener já põe no interactivePrompt. */
export function encodeApprovalPrompt(envelope: PendingApprovalEnvelope): string {
  return JSON.stringify({ approval: envelope });
}

export type ParsedApprovalPrompt = {
  readonly tool: string;
  readonly summary?: string;
  /** null = host antigo (só `{tool, summary}`): o cliente cai no fallback por tecla. */
  readonly structured: PendingApprovalEnvelope | null;
};

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function parseOptions(value: unknown): ApprovalOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > APPROVAL_DECISIONS.length) {
    return null;
  }
  const options: ApprovalOption[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { optionId, degradesTo } = raw as { optionId?: unknown; degradesTo?: unknown };
    if (!isApprovalDecision(optionId)) return null;
    if (degradesTo !== undefined && degradesTo !== 'accept') return null;
    options.push(degradesTo ? { optionId, degradesTo } : { optionId });
  }
  return options;
}

/**
 * Lê o `interactivePrompt` de aprovação. Sem `requestId` é o envelope antigo
 * (`structured: null`). Com `requestId` mas campos inválidos devolve null
 * inteiro: um host novo com envelope quebrado não pode virar resposta por
 * tecla no PTY.
 */
export function parseApprovalPrompt(raw: string | null | undefined): ParsedApprovalPrompt | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const approval = parsed && typeof parsed === 'object' ? (parsed as { approval?: unknown }).approval : null;
  if (!approval || typeof approval !== 'object') return null;
  const record = approval as Record<string, unknown>;
  const tool = boundedString(record.tool, MAX_TOOL_CHARS);
  if (!tool) return null;
  const summary = boundedString(record.summary, MAX_SUMMARY_CHARS) ?? undefined;
  if (record.requestId === undefined) {
    return { tool, ...(summary ? { summary } : {}), structured: null };
  }
  const requestId = boundedString(record.requestId, APPROVAL_REQUEST_ID_MAX_CHARS);
  const revision = record.revision;
  const options = parseOptions(record.options);
  const capability = record.responseCapability;
  if (
    !requestId ||
    requestId !== requestId.trim() ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    !options ||
    (capability !== 'live' && capability !== 'closed')
  ) {
    return null;
  }
  return {
    tool,
    ...(summary ? { summary } : {}),
    structured: {
      requestId,
      revision,
      tool,
      summary: summary ?? '',
      options,
      responseCapability: capability,
    },
  };
}
