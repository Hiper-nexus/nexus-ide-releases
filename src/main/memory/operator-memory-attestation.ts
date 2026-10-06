import { z } from 'zod';
import { createHash } from 'node:crypto';
import { normalizeSubject } from './memory-links';
import { redactSecretText } from '../terminal/command-redaction';
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits';
import type { ProjectExecutionScope } from '../../shared/types';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { getWorkspaceMemoryStore, type RetainResult } from './workspace-memory';

export const operatorMemoryAttestationSchema = z.object({
  type: z.enum(['architecture-rule', 'operator-preference', 'business-fact']),
  title: z.string().trim().min(1).max(256),
  summary: z.string().trim().min(1).max(6_000),
  scope: z.enum(['workspace', 'global']),
}).strict().refine((input) => input.type === 'operator-preference' || input.scope === 'workspace',
  { message: 'architecture rules and business facts belong to the attested project' });

/** Explicit topic identity; never a guessed category or raw secret in a key. */
export function operatorPreferenceReference(title: string): string {
  return `operator-preference:${createHash('sha256').update(normalizeSubject(redactSecretText(title).text)).digest('hex')}`;
}

/** Main renderer handler is the sole production caller; no repo file grants authority. */
export function retainOperatorMemoryAttestation(scope: ProjectExecutionScope,
  raw: z.input<typeof operatorMemoryAttestationSchema>): RetainResult {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)) throw new Error('workspace memory disabled');
  const input = operatorMemoryAttestationSchema.parse(raw);
  return getWorkspaceMemoryStore(scope).retain({
    content: clampUtf8TextPrefix(`# ${input.title}\n\nOperator attestation (${input.type}; ${input.scope}):${input.type === 'operator-preference' ? `\nReference: ${operatorPreferenceReference(input.title)}` : ''}\nSummary: ${input.summary}`, 7_800),
    kind: input.type === 'architecture-rule' ? 'decision' : input.type === 'business-fact' ? 'fact' : 'preference',
    importance: input.type === 'operator-preference' ? 4 : 5,
    source: `trusted:${input.type}`, scope: input.scope,
  });
}
