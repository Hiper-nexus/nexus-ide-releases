/**
 * Estado da pílula de sessão em Minha Conta.
 *
 * "conectado" em verde só quando nada contradiz o resto do cartão: se a
 * assinatura não pôde ser confirmada agora, ou se o servidor respondeu que a
 * sessão expirou (401 → mensagem do Main), a pílula não pode dizer o
 * contrário do texto logo ao lado.
 */

export type AccountSessionTone = 'in' | 'warn' | 'local' | 'loading';

export interface AccountSessionBadge {
  readonly label: string;
  readonly tone: AccountSessionTone;
  /** Mostrar "Entrar de novo" ao lado da pílula. */
  readonly offerRelogin: boolean;
}

export interface AccountSessionInput {
  readonly loading: boolean;
  readonly isLoggedIn: boolean;
  readonly licenseUnconfirmed: boolean;
  readonly sessionExpired: boolean;
}

/**
 * O Main traduz o HTTP 401 do backend Nexus sempre na mesma frase
 * (`team-ipc.ts`, `billing-ipc.ts`). Casamos pelo trecho estável, sem
 * depender de travessão ou do conselho que vem depois.
 */
export function isSessionExpiredError(error: string | null | undefined): boolean {
  return typeof error === 'string' && /sess[aã]o nexus expirou/i.test(error);
}

export function accountSessionBadge(input: AccountSessionInput): AccountSessionBadge {
  if (input.loading) return { label: '…', tone: 'loading', offerRelogin: false };
  if (!input.isLoggedIn) return { label: 'local', tone: 'local', offerRelogin: false };
  if (input.sessionExpired) {
    return { label: 'sessão expirada', tone: 'warn', offerRelogin: true };
  }
  if (input.licenseUnconfirmed) {
    return { label: 'a confirmar', tone: 'warn', offerRelogin: true };
  }
  return { label: 'conectado', tone: 'in', offerRelogin: false };
}
