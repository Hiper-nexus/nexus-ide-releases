import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { paneSpawnTool } from './tools-panes';
import {
  clearRouteProvenance,
  recordRouteDecision,
} from './route-provenance';

// Pin a user-selected default with a catalog warning. The product's current
// default may have no warning, but omitting model must still check user choices.
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/adapter-registry')>(),
  listAdapterInfos: () => [{ id: 'grok', models: { default: 'grok-4.5' } }],
}));

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
    // grok-4.7-build-fast tem warning e é o mais novo da própria linha
    // (`grok-#-build-fast`) — sem irmão mais novo, nada o substitui (F-218).
    const message = await spawnError({ adapterId: 'grok', model: 'grok-4.7-build-fast' });
    expect(message).toContain('route_required');
    expect(message).toContain('nexus_route_task');
  });

  it('F-218: o modelo pedido com warning sobe para o mais novo da linha — o gate olha o que VAI rodar', async () => {
    // grok-4.5 tem warning mas a CLI oferece grok-4.7 (mesma linha, limpo):
    // quem roda é o 4.7, então o gate de proveniência não dispara no 4.5.
    const message = await spawnError({ adapterId: 'grok', model: 'grok-4.5' });
    expect(message).not.toContain('route_required');
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
    // O default escolhido no registry é o grok-4.5 com warning — omitir
    // o model não pode virar bypass do gate.
    const message = await spawnError({ adapterId: 'grok' });
    expect(message).toContain('route_required');
    expect(message).toContain('grok-4.5');
  });
});
