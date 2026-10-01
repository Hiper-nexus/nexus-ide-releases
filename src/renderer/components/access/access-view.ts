import type { AccessBlockedReason } from '../../../shared/billing-types';

/** O que a tela de acesso diz e prioriza para cada motivo de bloqueio. */

/** Frase de apoio sob o título: o próximo passo, sem repetir o que o título já diz. */
export const ACCESS_COPY: Record<AccessBlockedReason, string> = {
  'startup-pending': 'Aguarde a confirmação da sua conta.',
  'login-required': 'Entre na sua conta Nexus para começar.',
  'verification-unavailable': 'Não foi possível consultar seu acesso agora. Tente novamente.',
  'invalid-license': 'Entre novamente para atualizar o acesso.',
  'license-expired': 'Entre novamente para atualizar o acesso.',
  'account-mismatch': 'Entre com a conta da assinatura.',
  suspended: 'Consulte sua assinatura no portal de cobrança.',
  inactive: 'Consulte o portal de cobrança ou assine o Pro.',
  'trial-ended': 'Assine o Pro para continuar.',
};

const TITLES: Record<AccessBlockedReason, string> = {
  'startup-pending': 'Consultando seu acesso',
  'login-required': 'Acesse o NexusIDE',
  'verification-unavailable': 'Acesso não confirmado',
  'invalid-license': 'Sua licença não pôde ser validada',
  'license-expired': 'Sua licença expirou',
  'account-mismatch': 'Esta licença é de outra conta',
  suspended: 'Seu acesso está suspenso',
  inactive: 'Sua assinatura está inativa',
  'trial-ended': 'Seu teste de 15 dias terminou',
};

export function accessTitle(loading: boolean, reason: AccessBlockedReason | null): string {
  if (loading) return TITLES['startup-pending'];
  return TITLES[reason ?? 'verification-unavailable'];
}

export type AccessPrimaryAction = 'login' | 'checkout' | 'portal' | 'retry';

interface PrimaryContext {
  isLoggedIn: boolean;
  /** A consulta de acesso falhou e há como repeti-la. */
  canRetry: boolean;
}

/**
 * A ÚNICA ação que a tela destaca (CTA branco e foco inicial). Cada motivo tem
 * exatamente uma saída natural; as demais ficam disponíveis, sem competir.
 */
export function accessPrimaryAction(
  reason: AccessBlockedReason | null,
  { isLoggedIn, canRetry }: PrimaryContext,
): AccessPrimaryAction {
  if (reason === 'verification-unavailable' && canRetry) return 'retry';
  if (!isLoggedIn) return 'login';
  if (reason === 'trial-ended' || reason === 'inactive') return 'checkout';
  if (reason === 'suspended') return 'portal';
  return 'login';
}

export type PaneTone = 'running' | 'ready' | 'pending';

const PANE_STATES: Record<string, { label: string; tone: PaneTone }> = {
  idle: { label: 'Aguardando', tone: 'ready' },
  busy: { label: 'Trabalhando', tone: 'running' },
  spawning: { label: 'Iniciando', tone: 'running' },
  exited: { label: 'Encerrado', tone: 'pending' },
  hibernated: { label: 'Em pausa', tone: 'pending' },
};

const PANE_FALLBACK = { label: 'Preservado', tone: 'pending' } as const;

/** Rótulo em texto + tom: o estado do terminal nunca viaja só em cor. */
export function paneStateView(state: string | undefined): { label: string; tone: PaneTone } {
  return (state !== undefined && PANE_STATES[state]) || PANE_FALLBACK;
}
