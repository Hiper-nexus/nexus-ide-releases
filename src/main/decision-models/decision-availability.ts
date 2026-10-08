import { createHash } from 'node:crypto';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { getOrchSettings } from '../persistence/settings-store';
import { hasJevCredential } from '../jev/jev-secrets';
import { hasClefCredential, resolveCloudflareAccountId, resolveClefApiToken } from './clef-secrets';
import { hasLunaCredential } from './luna-credentials';
import { resolveDecisionRoute, type DecisionAvailability } from './decision-routing';
import { decisionCredentialRevision } from './decision-revision';
import type { ClefConnection } from './clef-client';

export function getDecisionSettings(): DecisionSettings {
  return decisionSettingsSchema.parse(getOrchSettings().decisionModels ?? {});
}

export function getDecisionAvailability(settings = getDecisionSettings()): DecisionAvailability {
  // Modo fixo não lê cofre de provedor que não pode servir. Somente Luna ainda lê o Jev: as superfícies com efeito continuam lá.
  const mode = settings.mode;
  return {
    jev: mode === 'clef' ? false : hasJevCredential(),
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
  return accountId && token ? { accountId, token, model: settings.clefModel } : undefined;
}

/** No tokens or fingerprints: this key is process-local cache/in-flight authority. */
export function decisionConfigurationKey(): string {
  const settings = getDecisionSettings();
  return createHash('sha256').update(JSON.stringify({ settings, availability: getDecisionAvailability(settings),
    account: resolveCloudflareAccountId(settings.cloudflareAccountId),
    model: process.env.NEXUS_JEV_MODEL, revision: decisionCredentialRevision() })).digest('hex');
}
