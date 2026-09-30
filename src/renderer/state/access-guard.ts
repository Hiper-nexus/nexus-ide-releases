import { useAccessStore } from './access-store';
import { useToastStore } from './toast-store';
import { useProductNavigationStore } from './product-navigation-store';

export const TRIAL_AGENT_LIMIT_COPY = 'Você já está usando os 2 agentes do teste. Feche um para abrir outro ou assine o Pro.';
export function showAccessRefusal(limit = false): void {
  useToastStore.getState().push('warn', limit ? 'Limite de agentes atingido' : 'Acesso necessário', {
    detail: limit ? TRIAL_AGENT_LIMIT_COPY : 'Abra Minha conta para entrar ou atualizar sua assinatura.',
    dedupeKey: 'license-access',
    action: { label: 'Minha conta', onClick: () => useProductNavigationStore.getState().openSettings('account') },
  });
}
/** UX preflight only. Main still enforces access and counts physical agents atomically. */
export function allowPaneCreation(liveAgents?: number): boolean {
  const access = useAccessStore.getState();
  if (!access.canUseApp) { showAccessRefusal(); return false; }
  if (liveAgents !== undefined && access.maxAgents !== null && liveAgents >= access.maxAgents) {
    showAccessRefusal(true); return false;
  }
  return true;
}
export function reportLicenseDenial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!/license_(access_denied|agent_limit)/.test(message)) return false;
  showAccessRefusal(message.includes('license_agent_limit'));
  return true;
}
