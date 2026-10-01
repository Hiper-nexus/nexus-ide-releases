import { createHash } from 'node:crypto';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { getOrchSettings } from '../persistence/settings-store';
import { hasJevCredential } from '../jev/jev-secrets';
import { hasClefCredential, resolveCloudflareAccountId, resolveClefApiToken } from './clef-secrets';
import { resolveDecisionRoute, type DecisionAvailability } from './decision-routing';
import { decisionCredentialRevision } from './decision-revision';
import type { ClefConnection } from './clef-client';

export function getDecisionSettings(): DecisionSettings {
  return decisionSettingsSchema.parse(getOrchSettings().decisionModels ?? {});
}

export function getDecisionAvailability(settings = getDecisionSettings()): DecisionAvailability {
  return { jev: hasJevCredential(), clef: hasClefCredential() && Boolean(resolveCloudflareAccountId(settings.cloudflareAccountId)) };
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
