import { createHash } from 'node:crypto';
import { decisionSettingsSchema, hasAudioRecipientConsent, type DecisionSettings } from '../../shared/decision-models';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { getOrchSettings } from '../persistence/settings-store';
import { currentDecisionAccountId, decisionAccountBookFile, readDecisionAccountBook, resolveAccountSettings } from './decision-accounts';
import { hasJevCredential } from '../jev/jev-secrets';
import { hasClefCredential, resolveCloudflareAccountId, resolveClefApiToken } from './clef-secrets';
import { hasLunaCredential } from './luna-credentials';
import { resolveDecisionRoute, type DecisionAvailability } from './decision-routing';
import { decisionCredentialRevision } from './decision-revision';
import type { ClefConnection } from './clef-client';

export function getDecisionSettings(): DecisionSettings {
  const projection = decisionSettingsSchema.parse(getOrchSettings().decisionModels ?? {});
  const accountId = currentDecisionAccountId();
  if (!accountId) return projection;
  try {
    const { resolveSettingsFile } = require('../persistence/settings-store') as typeof import('../persistence/settings-store');
    return resolveAccountSettings(readDecisionAccountBook(decisionAccountBookFile(resolveSettingsFile())), accountId, projection);
  } catch {
    return projection;
  }
}

export function getDecisionAvailability(settings = getDecisionSettings()): DecisionAvailability {
  // Modo fixo não lê cofre de provedor que não pode servir. Somente Luna não lê o Jev: sem chave OpenAI a rota é nula.
  const mode = settings.mode;
  return {
    jev: mode === 'clef' || mode === 'luna' ? false : hasJevCredential(),
    clef: mode === 'jev' || mode === 'luna' ? false : hasClefCredential() && Boolean(resolveCloudflareAccountId(settings.cloudflareAccountId)),
    luna: mode === 'jev' || mode === 'clef' ? false : hasLunaCredential(),
  };
}

export function hasDecisionCredential(surface?: JevDecisionSurface): boolean {
  const settings = getDecisionSettings();
  return resolveDecisionRoute({ surface }, settings, getDecisionAvailability(settings)) !== null;
}

export function getClefConnection(settings = getDecisionSettings()): ClefConnection | undefined {
  const accountId = resolveCloudflareAccountId(settings.cloudflareAccountId);
  const token = resolveClefApiToken();
  return accountId && token
    ? { accountId, token, model: settings.clefModel, audioConsent: hasAudioRecipientConsent(settings, 'clef') } : undefined;
}

/** No tokens or fingerprints: this key is process-local cache/in-flight authority. */
export function decisionConfigurationKey(): string {
  const settings = getDecisionSettings();
  return createHash('sha256').update(JSON.stringify({ settings, availability: getDecisionAvailability(settings),
    account: resolveCloudflareAccountId(settings.cloudflareAccountId),
    model: process.env.NEXUS_JEV_MODEL, revision: decisionCredentialRevision() })).digest('hex');
}
