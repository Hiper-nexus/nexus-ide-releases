import { DECISION_MODEL_CHANNELS } from '../../shared/decision-model-channels';
import { decisionSettingsSchema, setDecisionKeyRequestSchema, type DecisionModelStatus, type DecisionSettings } from '../../shared/decision-models';
import { getOrchSettings } from '../persistence/settings-store';
import { handleTrusted } from '../security/trusted-ipc';
import { hasClefEnvToken, hasStoredClefApiToken, isClefSecretStorageAvailable, maskedClefApiToken, resolveCloudflareAccountId, setClefApiToken } from './clef-secrets';

interface DecisionModelIpcDeps {
  getSettings: () => DecisionSettings;
  hasStoredKey: () => boolean;
  hasEnv: () => boolean;
  keyMasked: () => string | null;
  secureStorageAvailable: () => boolean;
  setKey: typeof setClefApiToken;
}

const defaultDeps: DecisionModelIpcDeps = {
  getSettings: () => getOrchSettings().decisionModels ?? decisionSettingsSchema.parse({}),
  hasStoredKey: hasStoredClefApiToken,
  hasEnv: hasClefEnvToken,
  keyMasked: maskedClefApiToken,
  secureStorageAvailable: isClefSecretStorageAvailable,
  setKey: setClefApiToken,
};

export function registerDecisionModelIpc(overrides: Partial<DecisionModelIpcDeps> = {}): void {
  const deps = { ...defaultDeps, ...overrides };
  handleTrusted(DECISION_MODEL_CHANNELS.status, (): DecisionModelStatus => {
    const settings = deps.getSettings();
    const accountId = resolveCloudflareAccountId(settings.cloudflareAccountId) ?? '';
    const hasStoredKey = deps.hasStoredKey();
    const hasEnv = deps.hasEnv();
    return { settings, accountId, hasStoredKey, hasEnv, keyMasked: deps.keyMasked(),
      secureStorageAvailable: deps.secureStorageAvailable(),
      accountIdSource: !accountId ? 'missing' : settings.cloudflareAccountId ? 'settings' : 'env',
      isReady: Boolean(accountId && (hasStoredKey || hasEnv)),
    };
  });
  handleTrusted(DECISION_MODEL_CHANNELS.setKey, (_event, raw) => {
    const parsed = setDecisionKeyRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Token Cloudflare inválido.' };
    return deps.setKey(parsed.data.token);
  });
}
