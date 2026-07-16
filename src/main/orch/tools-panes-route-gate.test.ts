import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { paneSpawnTool } from './tools-panes';
import {
  clearRouteProvenance,
  recordRouteDecision,
} from './route-provenance';

function context(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'orch-token',
    label: 'orch',
    role: 'orchestrator',
    missionId: 'mission-a',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

async function spawnError(args: Record<string, unknown>): Promise<string> {
  try {
    await paneSpawnTool.handler(args, context());
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('fiação do gate de proveniência no nexus_pane_spawn ad-hoc', () => {
  beforeEach(() => clearRouteProvenance());

  it('recusa spawn ad-hoc de modelo com warning de catálogo sem decisão do router', async () => {
    const message = await spawnError({ adapterId: 'grok', model: 'grok-4.5' });
    expect(message).toContain('route_required');
    expect(message).toContain('nexus_route_task');
  });

  it('com decisão do router registrada, o gate deixa passar', async () => {
    recordRouteDecision({ adapterId: 'grok', model: 'grok-4.5' });
    const message = await spawnError({ adapterId: 'grok', model: 'grok-4.5' });
    // O spawn segue para as camadas seguintes (mission/stores) — qualquer
    // erro dali não pode ser o gate de rota.
    expect(message).not.toContain('route_required');
  });

  it('modelo sem warning não é gateado', async () => {
    const message = await spawnError({ adapterId: 'grok', model: 'grok-4.1' });
    expect(message).not.toContain('route_required');
  });

  it('spawn ad-hoc SEM model não contorna o gate: o default do adapter é avaliado', async () => {
    // O default do adapter grok é exatamente o grok-4.5 com warning — omitir
    // o model não pode virar bypass do gate.
    const message = await spawnError({ adapterId: 'grok' });
    expect(message).toContain('route_required');
    expect(message).toContain('grok-4.5');
  });
});
