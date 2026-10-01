import { z } from 'zod';

export const CLOUDFLARE_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';
export const CLOUDFLARE_ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID';
export const CLEF_SECRET_NAME = `clef-env:${CLOUDFLARE_TOKEN_ENV}`;

export const decisionSettingsSchema = z.object({
  mode: z.enum(['auto', 'jev', 'clef']).default('jev'),
  clefModel: z.enum(['clef', 'clef-flash']).default('clef'),
  cloudflareAccountId: z.string().trim().regex(/^(?:[a-fA-F0-9]{32})?$/).default(''),
  visionEnabled: z.boolean().default(false),
});

export const setDecisionKeyRequestSchema = z.object({
  token: z.string().trim().max(512).refine(value => !/[\r\n]/.test(value)),
}).strict();

export type DecisionSettings = z.infer<typeof decisionSettingsSchema>;
export type DecisionMode = DecisionSettings['mode'];
export type ClefModel = DecisionSettings['clefModel'];
export type DecisionProvider = 'jev' | 'clef';
export type SetDecisionKeyRequest = z.infer<typeof setDecisionKeyRequestSchema>;

export interface DecisionRoute {
  provider: DecisionProvider;
  model: string;
  policyVersion: 'jev-clef-v1';
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
  settings: DecisionSettings;
}
