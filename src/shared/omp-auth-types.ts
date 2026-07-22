import { z } from 'zod';

/**
 * Login OAuth de assinaturas do oh-my-pi (`omp auth-broker login <id>`)
 * dirigido pelo painel OMP·RPC — sem terminal. O main spawna o CLI, estreita
 * tudo o que chega dele e empurra eventos já validados; o renderer revalida
 * cada push com estes schemas (zod no receptor, mesma doutrina do
 * omp-rpc-types).
 *
 * Segredos NUNCA atravessam esta superfície: a sonda de conexão
 * (`omp token <id>`) é avaliada só por exit code no main com stdio ignorado —
 * o token jamais entra no heap do Nexus — e do stdout do login só atravessa a
 * URL https extraída (nunca o texto bruto).
 */

export const OMP_AUTH_CHANNELS = {
  listProviders: 'ompAuth:listProviders',
  login: 'ompAuth:login',
  cancelLogin: 'ompAuth:cancelLogin',
  /** Reabre/foca a janela in-app de autorização do fluxo ativo. */
  openAuthWindow: 'ompAuth:openAuthWindow',
  /** Push main → renderer: `{flowId, event}` já validado/estreitado. */
  event: 'ompAuth:event',
} as const;

// ---------------------------------------------------------------------------
// Schemas zod (payloads que chegam de fora: CLI e renderer).
// ---------------------------------------------------------------------------

/** Entrada de `omp auth-broker list --json` (sem a sonda de credencial). */
export const ompAuthBrokerEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
  })
  .strict();
export type OmpAuthBrokerEntry = z.infer<typeof ompAuthBrokerEntrySchema>;

/** Provedor como a UI o vê: metadados do broker + sonda local de credencial. */
export const ompAuthProviderInfoSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    connected: z.boolean(),
  })
  .strict();
export type OmpAuthProviderInfo = z.infer<typeof ompAuthProviderInfoSchema>;

export const ompAuthLoginRequestSchema = z
  .object({
    /** Validado no main contra a allowlist viva do `auth-broker list`. */
    providerId: z.string().min(1).max(128),
  })
  .strict();
export type OmpAuthLoginRequest = z.infer<typeof ompAuthLoginRequestSchema>;

/**
 * Eventos push main → renderer, JÁ estreitados:
 * - `awaiting-auth`: URL OAuth extraída do stdout — o renderer mostra e abre
 *   via openExternal https-only.
 * - `done`: exit 0, credencial gravada no cofre do próprio omp.
 * - `error`: exit ≠ 0, timeout (5 min) ou cancelamento pelo usuário.
 */
export const ompAuthPushEventSchema = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('awaiting-auth'),
      providerId: z.string().min(1).max(128),
      url: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      phase: z.literal('done'),
      providerId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      phase: z.literal('error'),
      providerId: z.string().min(1).max(128),
      message: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type OmpAuthPushEvent = z.infer<typeof ompAuthPushEventSchema>;

export const ompAuthEventEnvelopeSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    event: ompAuthPushEventSchema,
  })
  .strict();
export type OmpAuthEventEnvelope = z.infer<typeof ompAuthEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Resultados IPC + API do preload.
// ---------------------------------------------------------------------------

export interface OmpAuthListResult {
  ok: boolean;
  providers: OmpAuthProviderInfo[];
  error?: string;
}

export interface OmpAuthLoginResult {
  ok: boolean;
  flowId?: string;
  error?: string;
}

export interface OmpAuthCommandResult {
  ok: boolean;
  error?: string;
}

/**
 * API renderer-facing exposta pelo preload como `window.nexus.ompAuth`.
 * O renderer nunca vê o ipcRenderer cru — só este contrato.
 */
export interface OmpAuthApi {
  listProviders(): Promise<OmpAuthListResult>;
  login(providerId: string): Promise<OmpAuthLoginResult>;
  cancelLogin(): Promise<OmpAuthCommandResult>;
  /** Reabre/foca a janela in-app de autorização (URL é autoridade do main). */
  openAuthWindow(): Promise<OmpAuthCommandResult>;
  onEvent(cb: (envelope: OmpAuthEventEnvelope) => void): () => void;
}
