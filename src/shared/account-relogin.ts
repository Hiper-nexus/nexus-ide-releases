import { z } from 'zod';

/**
 * F-1637: a conta que o spawn provou precisar de login. Viaja do Main até o
 * cartão "Não subiu" do pane, que oferece o mesmo «Entrar novamente» do
 * painel de contas, com um clique. Só ids e o rótulo que o operador deu à
 * conta: nunca e-mail, token, fingerprint ou caminho de credencial.
 */
export interface AccountReloginRequest {
  readonly adapterId: string;
  readonly accountId: string;
  readonly accountLabel: string;
}

const accountReloginSchema = z.object({
  adapterId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  accountId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  accountLabel: z.string().min(1).max(120),
}).strict();

/** Lista de permissão: o que não casa com o contrato não vira botão. */
export function parseAccountReloginRequest(value: unknown): AccountReloginRequest | undefined {
  const parsed = accountReloginSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Recusa de spawn que se resolve entrando de novo NESSA conta. */
export class AccountReloginRequiredError extends Error {
  constructor(message: string, readonly relogin: AccountReloginRequest) {
    super(message);
    this.name = 'AccountReloginRequiredError';
  }
}

export function accountReloginFrom(error: unknown): AccountReloginRequest | undefined {
  return error instanceof AccountReloginRequiredError
    ? parseAccountReloginRequest(error.relogin)
    : undefined;
}
