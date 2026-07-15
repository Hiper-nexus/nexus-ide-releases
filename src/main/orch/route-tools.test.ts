import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: mocks.listProviderSettings,
}));

import { buildDomainTools } from './tools-domain';
import { clearRouteProvenance, hasRecentRouteMatch } from './route-provenance';
import { clearRouteLog, recentRouteLog } from './route-log';

const scope = testProjectScope();

function context(): AgentGateContext {
  return {
    token: 't',
    label: 'orch',
    role: 'orchestrator',
    missionId: 'm',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildDomainTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  clearRouteProvenance();
  clearRouteLog();
  mocks.listProviderSettings.mockReset();
});

describe('nexus_route_task wiring', () => {
  it('registra a decisão na proveniência E no route-log com o motivo', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'shell', enabled: true, installed: true, authStrategy: 'none', models: ['shell'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/kimi-for-coding'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.5'] },
    ]);
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; model?: string; reason: string };

    expect(decision.adapterId).toBeTruthy();
    // Proveniência gravada: o pick é reconhecido pelo gate de spawn ad-hoc.
    expect(hasRecentRouteMatch(decision.adapterId, decision.model)).toBe(true);
    // Route-log gravado com o motivo (observabilidade).
    const log = recentRouteLog();
    expect(log[0]).toMatchObject({ adapterId: decision.adapterId });
    expect(log[0].reason).toBeTruthy();
  });

  it('lança quando não há adapter roteável', async () => {
    mocks.listProviderSettings.mockReturnValue([]);
    await expect(
      tool('nexus_route_task').handler({ task: 'x' }, context()),
    ).rejects.toThrow(/no installed adapters/);
  });
});

describe('nexus_route_log handler', () => {
  it('respeita o limit e clampa 0..50', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/kimi-for-coding'] },
    ]);
    for (let i = 0; i < 3; i += 1) {
      await tool('nexus_route_task').handler({ task: `t${i} media` }, context());
    }
    const out = (await tool('nexus_route_log').handler({ limit: 2 }, context())) as {
      decisions: unknown[];
    };
    expect(out.decisions.length).toBe(2);
    const all = (await tool('nexus_route_log').handler({}, context())) as {
      decisions: unknown[];
    };
    expect(all.decisions.length).toBe(3);
  });
});

describe('nexus_clarify handler', () => {
  it('constrói chips e respeita allowFreeform boolean/ausente', async () => {
    const out = (await tool('nexus_clarify').handler(
      { question: 'Qual banco?', options: ['Postgres', 'MySQL'] },
      context(),
    )) as { chips: unknown[]; allowFreeform: boolean };
    expect(out.chips.length).toBe(2);
    expect(out.allowFreeform).toBe(true);

    const strict = (await tool('nexus_clarify').handler(
      { question: 'x', options: ['a', 'b'], allowFreeform: false },
      context(),
    )) as { allowFreeform: boolean };
    expect(strict.allowFreeform).toBe(false);
  });

  it('propaga o erro de validação (menos de 2 opções)', async () => {
    await expect(
      tool('nexus_clarify').handler({ question: 'x', options: ['só uma'] }, context()),
    ).rejects.toThrow(/opç/i);
  });
});
