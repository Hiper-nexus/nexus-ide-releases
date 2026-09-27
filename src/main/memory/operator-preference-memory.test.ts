import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import type { judge as jevJudge } from '../jev/jev-client';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';
import {
  distillOperatorPreferenceMemory,
  extractPreferenceCandidate,
} from './operator-preference-memory';

const dirs: string[] = [];
let scope: ProjectExecutionScope;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pref-root-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pref-db-'));
  dirs.push(root, baseDir);
  scope = {
    version: 1,
    installationId: 'installation-pref',
    projectId: 'project-pref',
    checkoutId: 'checkout-pref',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function judge(noul: number): Mock {
  return vi.fn<typeof jevJudge>(async () => ({
    model: 'jev-1.13.0',
    usage: { input_tokens: 120, output_tokens: 4 },
    answers: { is_preference: { type: 'noul', noul } },
  }));
}

const deps = (judgeFn: ReturnType<typeof judge>) => ({
  judge: judgeFn,
  enabled: () => true,
  hasKey: () => true,
});

describe('operator preference extraction', () => {
  it('extracts only the marker sentence as one line', () => {
    expect(
      extractPreferenceCandidate(
        'Refatore o módulo X. Sempre use pnpm neste projeto. Depois rode os testes.',
      ),
    ).toBe('Sempre use pnpm neste projeto.');
    expect(extractPreferenceCandidate('Rode os testes do módulo X.')).toBeNull();
    expect(
      extractPreferenceCandidate('prefiro\nnunca use emoji na UI'),
    ).toBe('prefiro nunca use emoji na UI');
  });
});

describe('operator preference memory', () => {
  it('skips prompts without a marker using zero Jev calls', async () => {
    const judgeFn = judge(0.95);
    const outcome = await distillOperatorPreferenceMemory(
      scope,
      'Corrija o bug do layout e rode os testes.',
      deps(judgeFn),
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'no-marker' });
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it('retains an approved preference as workspace-scoped memory', async () => {
    const judgeFn = judge(0.93);
    const outcome = await distillOperatorPreferenceMemory(
      scope,
      'Sempre use pnpm neste projeto, nunca npm.',
      deps(judgeFn),
    );
    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    const [hit] = getWorkspaceMemoryStore(scope).recall({
      query: 'pnpm projeto',
      includeGlobal: false,
    });
    expect(hit).toBeDefined();
    expect(hit.kind).toBe('preference');
    expect(hit.scope).toBe('workspace');
    expect(hit.source).toBe('trusted:operator-preference');
    expect(hit.content).toContain('Sempre use pnpm neste projeto');
    // nunca global automático
    expect(
      getWorkspaceMemoryStore(scope).stats().global.total,
    ).toBe(0);
  });

  it('fails open to no memory when Jev is unavailable or refuses', async () => {
    const nullJudge = vi.fn<typeof jevJudge>(async () => null);
    expect(
      await distillOperatorPreferenceMemory(scope, 'Nunca use tabs.', {
        judge: nullJudge,
        enabled: () => true,
        hasKey: () => true,
      }),
    ).toMatchObject({ retained: false, reason: 'jev-skip' });

    expect(
      await distillOperatorPreferenceMemory(scope, 'Sempre rode o lint.', deps(judge(0.2))),
    ).toMatchObject({ retained: false, reason: 'jev-skip' });
    expect(getWorkspaceMemoryStore(scope).stats().workspace.total).toBe(0);
  });
});
