import { z } from 'zod';

/**
 * Variáveis de ambiente PRÓPRIAS do Nexus. `CLOUDFLARE_API_TOKEN` e
 * `CLOUDFLARE_ACCOUNT_ID` são as do wrangler e costumam guardar um token de
 * escopo largo (deploy, DNS, KV…): o Nexus nunca as adota por tabela.
 */
export const CLEF_TOKEN_ENV = 'NEXUS_CLEF_API_TOKEN';
export const CLEF_ACCOUNT_ENV = 'NEXUS_CLEF_ACCOUNT_ID';
/** Rótulo do cofre (já gravado em instalações e bundles exportados): não renomear. */
export const CLEF_SECRET_NAME = 'clef-env:CLOUDFLARE_API_TOKEN';

/** Decisions API. Não é o modelo de geração do pane: a rota de texto não usa este id. */
export const LUNA_DECISION_MODEL = 'gpt-6-luna';

export const decisionSettingsSchema = z.object({
  mode: z.enum(['auto', 'jev', 'clef', 'luna', 'together']).default('jev'),
  clefModel: z.enum(['clef', 'clef-flash']).default('clef'),
  cloudflareAccountId: z.string().trim().regex(/^(?:[a-fA-F0-9]{32})?$/).default(''),
  visionEnabled: z.boolean().default(false),
  /** Absent = legacy Cloudflare-only consent; a new recipient always needs an explicit grant. */
  visionConsent: z.object({ version: z.literal(1), recipients: z.array(z.enum(['clef', 'luna'])).max(2) }).strict().optional(),
}).transform(settings => settings.mode === 'jev' || !settings.visionEnabled ? { ...settings, visionEnabled: false,
  ...(settings.visionConsent ? { visionConsent: { version: 1 as const, recipients: [] } } : {}),
} : settings);

export const setDecisionKeyRequestSchema = z.object({
  token: z.string().trim().max(512).refine(value => !/[\r\n]/.test(value)),
}).strict();

export const testDecisionModelRequestSchema = z.object({
  model: z.enum(['clef', 'clef-flash']).optional(),
  provider: z.enum(['clef', 'luna']).optional(),
}).strict();

export type DecisionSettings = z.infer<typeof decisionSettingsSchema>;
export type DecisionMode = DecisionSettings['mode'];
export type VisionRecipient = 'clef' | 'luna';

/** Legacy consent authorizes Cloudflare only, regardless of a later mode/key change. */
export function hasVisionRecipientConsent(settings: DecisionSettings, recipient: VisionRecipient): boolean {
  if (!settings.visionEnabled || settings.mode === 'jev') return false;
  return settings.visionConsent
    ? settings.visionConsent.version === 1 && settings.visionConsent.recipients.includes(recipient) : recipient === 'clef';
}

export function visionRecipientsForMode(mode: DecisionMode): VisionRecipient[] {
  return mode === 'jev' ? [] : mode === 'clef' ? ['clef'] : mode === 'luna' ? ['luna'] : ['clef', 'luna'];
}

export interface DecisionUsageReceipt {
  inputTokens: number | null; usd: number | null; requestCount: number; durationMs: number; usageIncomplete: boolean;
}
export type ClefModel = DecisionSettings['clefModel'];
export type DecisionProvider = 'jev' | 'clef' | 'luna';
export type SetDecisionKeyRequest = z.infer<typeof setDecisionKeyRequestSchema>;
export type TestDecisionModelRequest = z.infer<typeof testDecisionModelRequestSchema>;

export interface DecisionRoute {
  provider: DecisionProvider;
  model: string;
  policyVersion: 'jev-clef-v1' | 'jev-clef-luna-v1';
  evidence: 'public-benchmark' | 'legacy' | 'manual' | 'capability';
  reason: string;
}

export interface DecisionImage {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export interface DecisionModelStatus {
  hasStoredKey: boolean;
  hasEnv: boolean;
  keyMasked: string | null;
  secureStorageAvailable: boolean;
  accountId: string;
  accountIdSource: 'settings' | 'env' | 'missing';
  isReady: boolean;
  /** A chave Jev existe (presença apenas): a UI avisa quando o Automático cairia na Cloudflare. */
  jevReady: boolean;
  /** A chave OpenAI existe (presença apenas): é a credencial da Decisions API (Luna, beta). */
  lunaReady: boolean;
  settings: DecisionSettings;
}
