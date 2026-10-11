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

/** Variantes Cloudflare aceitas. Clef-omni é a única que entende áudio. */
export const CLEF_MODELS = ['clef', 'clef-flash', 'clef-omni'] as const;
export const CLEF_AUDIO_MODEL = 'clef-omni';

/** Orçamento de decisão por missão (F-1164). 0 ou ausente = padrão. */
export const DEFAULT_MISSION_DECISION_BUDGET_USD = 0.5;
export const MAX_MISSION_DECISION_BUDGET_USD = 20;

export const decisionSettingsSchema = z.object({
  mode: z.enum(['auto', 'jev', 'clef', 'luna', 'together']).default('jev'),
  clefModel: z.enum(CLEF_MODELS).default('clef'),
  cloudflareAccountId: z.string().trim().regex(/^(?:[a-fA-F0-9]{32})?$/).default(''),
  visionEnabled: z.boolean().default(false),
  /** Absent = legacy Cloudflare-only consent; a new recipient always needs an explicit grant. */
  visionConsent: z.object({ version: z.literal(1), recipients: z.array(z.enum(['clef', 'luna'])).max(2) }).strict().optional(),
  /**
   * Autorização própria para clipes de voz curtos irem à Cloudflare (Clef-omni).
   * Ausente = nunca autorizado; não herda o consentimento de imagens.
   */
  audioConsent: z.object({ version: z.literal(1), recipients: z.array(z.enum(['clef'])).max(1) }).strict().optional(),
  /**
   * Teto em US$ das decisões de UMA missão no Automático (F-1164). 0 ou ausente = US$ 0,50.
   * Fora da faixa vira ausente (padrão): um campo novo inválido nunca derruba o
   * parse inteiro, que voltaria a configuração do operador para Somente Jev.
   */
  missionBudgetUsd: z.number().finite().min(0).max(MAX_MISSION_DECISION_BUDGET_USD).optional().catch(undefined),
}).transform(settings => {
  const vision = settings.mode === 'jev' || !settings.visionEnabled ? { ...settings, visionEnabled: false,
    ...(settings.visionConsent ? { visionConsent: { version: 1 as const, recipients: [] } } : {}),
  } : settings;
  // Sem rota Cloudflare ou sem Clef-omni o áudio não tem destino: a autorização cai e não volta sozinha.
  const audioInert = settings.mode === 'jev' || settings.mode === 'luna' || settings.clefModel !== CLEF_AUDIO_MODEL;
  return audioInert && vision.audioConsent ? { ...vision, audioConsent: { version: 1 as const, recipients: [] } } : vision;
});

export const setDecisionKeyRequestSchema = z.object({
  token: z.string().trim().max(512).refine(value => !/[\r\n]/.test(value)),
}).strict();

export const testDecisionModelRequestSchema = z.object({
  model: z.enum(CLEF_MODELS).optional(),
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

/** Áudio sai só com Clef-omni, numa rota que aceita Cloudflare e com a autorização versionada. */
export function hasAudioRecipientConsent(settings: DecisionSettings, recipient: 'clef'): boolean {
  if (settings.mode === 'jev' || settings.mode === 'luna' || settings.clefModel !== CLEF_AUDIO_MODEL) return false;
  return settings.audioConsent?.version === 1 && settings.audioConsent.recipients.includes(recipient);
}

export function visionRecipientsForMode(mode: DecisionMode): VisionRecipient[] {
  return mode === 'jev' ? [] : mode === 'clef' ? ['clef'] : mode === 'luna' ? ['luna'] : ['clef', 'luna'];
}

/** Orçamento efetivo da missão: 0, ausente ou inválido vira o padrão. */
export function missionDecisionBudgetUsd(settings: Pick<DecisionSettings, 'missionBudgetUsd'>): number {
  const value = settings.missionBudgetUsd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_MISSION_DECISION_BUDGET_USD
    ? value : DEFAULT_MISSION_DECISION_BUDGET_USD;
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
  /** v2 = motor custo×qualidade do Automático (F-1165). */
  policyVersion: 'jev-clef-v1' | 'jev-clef-luna-v1' | 'decision-engine-v2';
  /** local-evaluation = tabela gerada por evaluateDecisionCases; prior = qualidade embutida. */
  evidence: 'public-benchmark' | 'legacy' | 'manual' | 'capability' | 'local-evaluation' | 'prior';
  reason: string;
}

export interface DecisionImage {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

/** Clipe de voz curto. Vai à Cloudflare como data URL, nunca como URL remota. */
export interface DecisionAudio {
  content_type: 'audio/wav' | 'audio/mpeg';
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
