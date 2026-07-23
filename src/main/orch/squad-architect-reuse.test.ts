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

import { chatViaBrainChain } from '../voice/jarvis-brain';
import {
  designSquadForWorkspace,
  designSquadFromIntent,
} from './squad-architect';

const chatViaBrainChainMock = vi.mocked(chatViaBrainChain);

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
    chatViaBrainChainMock.mockReset();
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

  it('não persiste fallback determinístico quando a autoridade já foi revogada', async () => {
    listSquadsMock.mockReturnValue([]);

    await expect(
      designSquadFromIntent('melhorar o onboarding', '/tmp/ws', {
        assertCurrentAuthority: () => {
          throw new Error('renderer workspace authority changed');
        },
      }),
    ).rejects.toThrow('renderer workspace authority changed');
    expect(saveSquadMock).not.toHaveBeenCalled();
  });

  it('cancela o provider externo e não persiste quando o escopo é revogado', async () => {
    const controller = new AbortController();
    listSquadsMock.mockReturnValue([]);
    chatViaBrainChainMock.mockImplementation(
      async (_messages, _maxTokens, _deps, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const flight = designSquadForWorkspace('/tmp/ws', {
      signal: controller.signal,
      assertCurrentAuthority: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
    });
    await vi.waitFor(() =>
      expect(chatViaBrainChainMock).toHaveBeenCalledTimes(1),
    );
    controller.abort(new Error('renderer workspace authority changed'));

    await expect(flight).rejects.toThrow('renderer workspace authority changed');
    expect(saveSquadMock).not.toHaveBeenCalled();
    expect(chatViaBrainChainMock.mock.calls[0]?.[3]).toBe(controller.signal);
  });
});
