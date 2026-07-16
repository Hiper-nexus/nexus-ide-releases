import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
} from '../memory/workspace-memory';
import type { AgentGateContext } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
import { buildMemoryTools } from './tools-memory';
import { buildToolset } from './tools';

function context(
  projectId: string,
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: `token-${projectId}`,
    label: 'memory-worker',
    role: 'worker',
    scope: {
      version: 1,
      installationId: 'installation-a',
      projectId,
      checkoutId: `checkout-${projectId}`,
      rootRealPath: `/private/${projectId}`,
      identitySource: 'manifest',
    },
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function toolByName(name: string) {
  const tool = buildMemoryTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not built: ${name}`);
  return tool;
}

const dirs: string[] = [];

beforeEach(() => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wm-tools-'));
  dirs.push(baseDir);
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, false);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('nexus_memory_* tools', () => {
  it('registra as três tools no toolset central com as políticas esperadas', () => {
    const names = buildToolset().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'nexus_memory_retain',
        'nexus_memory_recall',
        'nexus_memory_stats',
      ]),
    );
    expect(effectPolicyForTool('nexus_memory_recall')).toBe('read-only');
    expect(effectPolicyForTool('nexus_memory_stats')).toBe('read-only');
    // Mutação estreita permitida antes de contrato (memória local, validada).
    expect(effectPolicyForTool('nexus_memory_retain')).toBe(
      'bootstrap-authority',
    );
  });

  it('faz retain e recall pelo escopo do gate, ignorando args de escopo alheio', async () => {
    const retain = toolByName('nexus_memory_retain');
    const recall = toolByName('nexus_memory_recall');
    const ctx = context('project-a');

    const retained = (await retain.handler(
      { content: 'workspace uses pnpm not npm', kind: 'decision' },
      ctx,
    )) as { id: string; deduped: boolean };
    expect(retained.id).toMatch(/^mem-/);
    expect(retained.deduped).toBe(false);

    const hits = (await recall.handler({ query: 'pnpm npm' }, ctx)) as Array<{
      content: string;
      source: string | null;
    }>;
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('pnpm');
    // Proveniência default: pane/CLI que gravou (sem missão neste contexto).
    expect(hits[0].source).toBe('pane:memory-worker');

    // Outro workspace não enxerga a memória do primeiro.
    const other = (await recall.handler(
      { query: 'pnpm npm' },
      context('project-b'),
    )) as unknown[];
    expect(other).toEqual([]);
  });

  it('usa mission:<id> como source quando o gate está em missão', async () => {
    const retain = toolByName('nexus_memory_retain');
    const recall = toolByName('nexus_memory_recall');
    const ctx = context('project-m', { missionId: 'mission-42' });
    await retain.handler({ content: 'mission memo about caching' }, ctx);
    const hits = (await recall.handler({ query: 'caching memo' }, ctx)) as Array<{
      source: string | null;
    }>;
    expect(hits[0].source).toBe('mission:mission-42');
  });

  it('valida args com zod estrito (arg desconhecido é rejeitado)', async () => {
    const recall = toolByName('nexus_memory_recall');
    await expect(
      recall.handler(
        { query: 'anything', projectId: 'attacker-project' },
        context('project-a'),
      ),
    ).rejects.toThrow();
    const retain = toolByName('nexus_memory_retain');
    await expect(
      retain.handler({ content: '' }, context('project-a')),
    ).rejects.toThrow();
  });

  it('stats agrega workspace + global sem expor conteúdo nem paths', async () => {
    const retain = toolByName('nexus_memory_retain');
    const stats = toolByName('nexus_memory_stats');
    const ctx = context('project-s');
    await retain.handler({ content: 'a workspace secret-free fact' }, ctx);
    await retain.handler(
      { content: 'a user-global preference', scope: 'global', kind: 'preference' },
      ctx,
    );
    const result = (await stats.handler({}, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({
      workspace: { active: 1 },
      global: { active: 1 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-free fact');
    expect(serialized).not.toContain(os.tmpdir());
  });

  it('falha fechado quando a feature flag está desligada', async () => {
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.workspaceMemory,
      false,
    );
    const retain = toolByName('nexus_memory_retain');
    await expect(
      retain.handler({ content: 'should not persist' }, context('project-a')),
    ).rejects.toThrow(/feature\.memory\.workspaceMemory is disabled/);
  });
});
