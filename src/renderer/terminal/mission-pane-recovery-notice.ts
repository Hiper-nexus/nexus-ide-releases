/**
 * F-1581: a linha que o pane do Maestro escreve quando o Main troca a sessão
 * dele. Antes era sempre "[nexus] contexto degradado — iniciando uma sessão
 * limpa…", inclusive numa troca de conta por limite confirmado ou quando o
 * Maestro não aceitava uma entrega — o operador lia um defeito que não houve.
 *
 * O motivo vem no próprio pedido do Main (`MissionPaneRecoveryRequest.reason`).
 * O orch-bridge repassa ao terminal só o `requestId`; este módulo ouve o mesmo
 * pedido (a ponte do preload aceita vários ouvintes, chamados no mesmo turno,
 * antes do primeiro `await` do orch-bridge) e guarda o motivo por `requestId`.
 */
import type {
  MissionPaneRecoveryReason,
  MissionPaneRecoveryRequest,
} from '../../shared/orch-types';

const KNOWN_REASONS: ReadonlySet<MissionPaneRecoveryReason> = new Set([
  'account-failover',
  'handoff-delivery',
]);
/** Pedidos de recuperação são raros; o teto só evita crescer sem fim. */
const MAX_REMEMBERED = 32;

const reasons = new Map<string, MissionPaneRecoveryReason>();
let subscribed = false;

/** Guarda o motivo de um pedido do Main (lista fechada; o resto é ignorado). */
export function rememberMissionPaneRecoveryReason(
  request: Pick<MissionPaneRecoveryRequest, 'requestId' | 'reason'>,
): void {
  const { requestId, reason } = request;
  if (typeof requestId !== 'string' || !requestId) return;
  if (!reason || !KNOWN_REASONS.has(reason)) return;
  reasons.delete(requestId);
  reasons.set(requestId, reason);
  while (reasons.size > MAX_REMEMBERED) {
    const oldest = reasons.keys().next().value;
    if (oldest === undefined) break;
    reasons.delete(oldest);
  }
}

/** O motivo do pedido `requestId`, uma vez (lido, sai da lista). */
export function takeMissionPaneRecoveryReason(
  requestId: string | undefined,
): MissionPaneRecoveryReason | undefined {
  if (!requestId) return undefined;
  const reason = reasons.get(requestId);
  reasons.delete(requestId);
  return reason;
}

/**
 * Assina os pedidos de recuperação do Main uma vez. Idempotente:
 * chamado a cada host criado, porque o pane que se recupera sempre tem host.
 */
export function installMissionPaneRecoveryReasonListener(): void {
  if (typeof window === 'undefined') return;
  const orch = window.nexus?.orch;
  if (subscribed || typeof orch?.onPaneRecoveryRequest !== 'function') return;
  subscribed = true;
  orch.onPaneRecoveryRequest((request) => rememberMissionPaneRecoveryReason(request));
}

const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** A linha amarela que o terminal escreve antes de subir a sessão nova. */
export function missionPaneRecoveryNotice(
  reason: MissionPaneRecoveryReason | undefined,
  resumeNative: boolean,
): string {
  const text = resumeNative
    ? 'conta trocada — retomando a mesma conversa na conta nova…'
    : reason === 'account-failover'
      ? 'troca de conta por limite confirmado — sessão nova com o resumo da anterior…'
      : reason === 'handoff-delivery'
        ? 'o Maestro não aceitou a entrega — sessão nova retomando a missão…'
        : 'recuperação automática — iniciando uma sessão nova…';
  return `\r\n${YELLOW}[nexus] ${text}${RESET}`;
}

/** Só para testes: esquece motivos e a assinatura. */
export function resetMissionPaneRecoveryReasonsForTests(): void {
  reasons.clear();
  subscribed = false;
}
