import { z } from 'zod';
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits';
import type { ProjectExecutionScope } from '../../shared/types';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { getWorkspaceMemoryStore, type RetainResult } from './workspace-memory';

export const operatorMemoryAttestationSchema = z.object({
  type: z.enum(['architecture-rule', 'operator-preference']),
  title: z.string().trim().min(1).max(256),
  summary: z.string().trim().min(1).max(6_000),
  scope: z.enum(['workspace', 'global']),
}).strict().refine((input) => input.type === 'operator-preference' || input.scope === 'workspace',
  { message: 'architecture rules belong to the attested project' });

/** Main renderer handler is the sole production caller; no repo file grants authority. */
export function retainOperatorMemoryAttestation(scope: ProjectExecutionScope,
  raw: z.input<typeof operatorMemoryAttestationSchema>): RetainResult {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)) throw new Error('workspace memory disabled');
  const input = operatorMemoryAttestationSchema.parse(raw);
  return getWorkspaceMemoryStore(scope).retain({
    content: clampUtf8TextPrefix(`# ${input.title}\n\nOperator attestation (${input.type}; ${input.scope}):\nSummary: ${input.summary}`, 7_800),
    kind: input.type === 'architecture-rule' ? 'decision' : 'preference',
    importance: input.type === 'architecture-rule' ? 5 : 4,
    source: `trusted:${input.type}`, scope: input.scope,
  });
}
