import { DECISION_MODEL_CHANNELS } from '../../shared/decision-model-channels';
import { decisionSettingsSchema, setDecisionKeyRequestSchema, testDecisionModelRequestSchema, type DecisionModelStatus, type DecisionSettings } from '../../shared/decision-models';
import { getOrchSettings } from '../persistence/settings-store';
import { handleTrusted } from '../security/trusted-ipc';
import { hasClefEnvToken, hasStoredClefApiToken, isClefSecretStorageAvailable, maskedClefApiToken, resolveCloudflareAccountId, resolveClefApiToken, setClefApiToken } from './clef-secrets';
import { testClefConnection } from './clef-client';

interface DecisionModelIpcDeps {
  getSettings: () => DecisionSettings;
  hasStoredKey: () => boolean;
  hasEnv: () => boolean;
  keyMasked: () => string | null;
  secureStorageAvailable: () => boolean;
  setKey: typeof setClefApiToken;
  resolveToken: typeof resolveClefApiToken;
  testConnection: typeof testClefConnection;
}

const defaultDeps: DecisionModelIpcDeps = {
  getSettings: () => getOrchSettings().decisionModels ?? decisionSettingsSchema.parse({}),
  hasStoredKey: hasStoredClefApiToken,
  hasEnv: hasClefEnvToken,
  keyMasked: maskedClefApiToken,
  secureStorageAvailable: isClefSecretStorageAvailable,
  setKey: setClefApiToken,
  resolveToken: resolveClefApiToken,
  testConnection: testClefConnection,
};

function registerConnectionTest(deps: DecisionModelIpcDeps): void {
  handleTrusted(DECISION_MODEL_CHANNELS.test, async (_event, raw) => {
    const parsed = testDecisionModelRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, detail: 'Modelo Clef inválido.' };
    const settings = deps.getSettings();
    const accountId = resolveCloudflareAccountId(settings.cloudflareAccountId);
    const token = deps.resolveToken();
    if (!accountId || !token) return { ok: false, detail: 'Configure o Account ID e o API Token da Cloudflare.' };
    return deps.testConnection({ accountId, token, model: parsed.data.model ?? settings.clefModel });
  });
}

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
  registerConnectionTest(deps);
}
