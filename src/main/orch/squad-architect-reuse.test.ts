import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSquadsMock = vi.fn();
const saveSquadMock = vi.fn();
const listAdapterInfosMock = vi.fn();

vi.mock('./squad-store', () => ({
  listSquads: (...args: unknown[]) => listSquadsMock(...args),
  saveSquad: (...args: unknown[]) => saveSquadMock(...args),
}));
vi.mock('../adapters/adapter-registry', () => ({
  listAdapterInfos: (...args: unknown[]) => listAdapterInfosMock(...args),
}));
vi.mock('../voice/jarvis-brain', () => ({ chatViaBrainChain: vi.fn() }));
vi.mock('../runtime/doctor-diagnostic-engine', () => ({
  diagnoseWithDoctorGrok: vi.fn(),
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({})),
}));

import { designSquadFromIntent } from './squad-architect';

function adapterInfo(id: string, orchestratorCapable = true) {
  return {
    id,
    installed: true,
    orchestratorCapable,
    models: { default: `${id}-default`, list: [`${id}-default`] },
  };
}

const savedSquad = {
  id: 'meu-time',
  name: 'Meu Time',
  builtin: false,
  createdAt: '2000',
  orchestratorInstructions: '',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
    { id: 'rev', agentName: 'Revisor', category: 'reviewer', cli: 'kimi' },
  ],
};

describe('designSquadFromIntent honra squad salvo (fiação RC4)', () => {
  beforeEach(() => {
    listSquadsMock.mockReset();
    saveSquadMock.mockReset();
    listAdapterInfosMock.mockReset();
    listAdapterInfosMock.mockReturnValue([
      adapterInfo('claude'),
      adapterInfo('kimi', false),
      adapterInfo('codex'),
    ]);
    saveSquadMock.mockImplementation((raw) => raw);
  });

  it('reusa o squad salvo do usuário em vez de sintetizar fallback', async () => {
    listSquadsMock.mockReturnValue([savedSquad]);
    const result = await designSquadFromIntent('melhorar o onboarding', '/tmp/ws');
    expect(result.ok).toBe(true);
    expect(result.squad?.id).toBe('meu-time');
    expect(saveSquadMock).not.toHaveBeenCalled();
    expect(result.warning).toContain('Meu Time');
  });

  it('sem squad elegível, cai no fallback determinístico (comportamento anterior)', async () => {
    listSquadsMock.mockReturnValue([{ ...savedSquad, builtin: true }]);
    const result = await designSquadFromIntent('melhorar o onboarding', '/tmp/ws');
    expect(result.ok).toBe(true);
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
    expect(saveSquadMock).toHaveBeenCalledTimes(1);
  });

  it('squad salvo com cli não instalado não é reusado', async () => {
    listSquadsMock.mockReturnValue([
      {
        ...savedSquad,
        agents: [{ id: 'x', agentName: 'X', category: 'executor', cli: 'glm' }],
      },
    ]);
    const result = await designSquadFromIntent('melhorar o onboarding', '/tmp/ws');
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
  });
});
