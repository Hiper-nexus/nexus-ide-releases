import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

let root: string;
afterEach(() => { disposeWorkspaceMemoryStores(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('operator attestation writes architecture rule and explicit global preference with durable provenance', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-attest-'));
  const scope = testProjectScope();
  configureWorkspaceMemory({ baseDir: root });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  const { retainOperatorMemoryAttestation } = await import('./operator-memory-attestation');
  retainOperatorMemoryAttestation(scope, { type: 'architecture-rule', title: 'Atomic billing', summary: 'A transação em src/billing.ts cobre pagamento e recibo.', scope: 'workspace' });
  retainOperatorMemoryAttestation(scope, { type: 'operator-preference', title: 'Idioma', summary: 'Sempre responda em português.', scope: 'global' });
  const store = getWorkspaceMemoryStore(scope);
  const [rule] = store.recall({ query: 'billing' });
  expect(rule.source).toBe('trusted:architecture-rule'); expect(rule.content).toContain('Operator attestation');
  const other = getWorkspaceMemoryStore(testProjectScope({ projectId: 'other' }));
  expect(other.recall({ query: 'billing' })).toHaveLength(0);
  expect(other.recall({ query: 'português' })[0]?.scope).toBe('global');
  expect(() => retainOperatorMemoryAttestation(scope, { type: 'architecture-rule', title: 'Bad scope', summary: 'Global rule', scope: 'global' })).toThrow();
});
