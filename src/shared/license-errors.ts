import type { AccessBlockedReason } from './billing-types';

/** Stable product errors. Never use authority/respawn recovery vocabulary in messages. */
export type LicenseErrorCode = 'license_access_denied' | 'license_agent_limit';
export type LicenseDenialReason = AccessBlockedReason | 'cloud-sync-disabled' | 'remote-trial-unavailable' | 'server-denied';
export interface LicenseFailure {
  ok: false;
  code: LicenseErrorCode;
  error: string;
  blockedReason?: LicenseDenialReason;
}
const messages: Partial<Record<LicenseDenialReason, string>> = {
  'verification-unavailable': 'Não foi possível consultar seu acesso agora. Tente novamente.',
  'invalid-license': 'Não foi possível validar sua licença. Entre novamente para atualizar o acesso.',
  'account-mismatch': 'A licença pertence a outra conta. Entre com a conta da assinatura.',
  'server-denied': 'O servidor recusou seu acesso. Acesse sua conta para atualizar a licença.',
  'login-required': 'Entre na sua conta para usar o NexusIDE.',
  'trial-ended': 'Seu teste terminou. Assine o Pro para continuar.',
  suspended: 'Esta conta está suspensa. Acesse sua conta para obter ajuda.',
  inactive: 'Assine o Pro para continuar usando o NexusIDE.',
  'license-expired': 'Conecte-se à internet para atualizar sua licença do NexusIDE.',
  'cloud-sync-disabled': 'Seu plano não inclui sincronização na nuvem. Assine o Pro para usar este recurso.',
  'remote-trial-unavailable': 'Execuções remotas estão disponíveis com o Pro. Assine para abrir uma execução remota.',
};
export class LicenseError extends Error {
  constructor(readonly code: LicenseErrorCode, readonly reason?: LicenseDenialReason, readonly limit?: number) {
    const message = code === 'license_agent_limit'
      ? `Você já está usando os ${limit} agentes do teste. Feche um para abrir outro ou assine o Pro.`
      : messages[reason!] ?? 'Não foi possível confirmar seu acesso ao NexusIDE. Acesse sua conta para atualizar a licença.';
    super(`${code}: ${message}`);
    this.name = 'LicenseError';
  }
}
export function licenseFailure(error: unknown): LicenseFailure | null {
  const denial = licenseErrorFrom(error);
  if (!denial) return null;
  return { ok: false, code: denial.code, error: denial.message, ...(denial.reason ? { blockedReason: denial.reason } : {}) };
}

/** Electron/legacy pane ACKs may retain only Error.message. Recover the product denial. */
export function licenseErrorFrom(value: unknown): LicenseError | null {
  if (value instanceof LicenseError) return value;
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const code = message.match(/\b(license_access_denied|license_agent_limit):/)?.[1] as LicenseErrorCode | undefined;
  if (!code) return null;
  const reason = code === 'license_access_denied'
    ? (Object.entries(messages).find(([, copy]) => message.endsWith(`: ${copy}`))?.[0] as LicenseDenialReason | undefined)
    : undefined;
  const limitText = code === 'license_agent_limit' ? message.match(/Você já está usando os (\d+) agentes do teste\./)?.[1] : undefined;
  const limit = limitText === undefined ? undefined : Number(limitText);
  const error = new LicenseError(code, reason, limit !== undefined && Number.isSafeInteger(limit) ? limit : undefined);
  error.message = message;
  return error;
}
