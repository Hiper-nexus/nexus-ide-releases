import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeInfo = {
  running: true,
  port: 4242,
  urls: ['wss://127.0.0.1:4242'],
  pairingCode: 'SECRETCODE',
  pairingExpiresAt: 999_999,
  tokenCount: 1,
  clientCount: 1,
  certFingerprint: 'AA:BB',
};

const mocks = vi.hoisted(() => ({
  getRemoteBridgeInfo: vi.fn(),
  redactRemoteBridgeSecrets: vi.fn((info: Record<string, unknown>) => {
    const safe = { ...info };
    delete safe.pairingCode;
    delete safe.pairingExpiresAt;
    return safe;
  }),
  rotateRemotePairing: vi.fn(),
  startRemoteBridge: vi.fn(),
  stopRemoteBridge: vi.fn(),
}));

vi.mock('../remote/remote-bridge', () => mocks);

import { runRemoteBridgeToolAction } from './remote-bridge-tool';
import { buildDomainTools } from './tools-domain';

describe('remote bridge MCP tool boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRemoteBridgeInfo.mockReturnValue(bridgeInfo);
    mocks.rotateRemotePairing.mockReturnValue(bridgeInfo);
    mocks.startRemoteBridge.mockResolvedValue(bridgeInfo);
    mocks.stopRemoteBridge.mockReturnValue(bridgeInfo);
  });

  it.each(['status', 'start', 'stop', 'rotate_pairing'] as const)(
    'never exposes the pairing secret for action %s',
    async (action) => {
      const result = await runRemoteBridgeToolAction(action, 4242);

      expect(result).toMatchObject({ running: true, port: 4242 });
      expect(result).not.toHaveProperty('pairingCode');
      expect(result).not.toHaveProperty('pairingExpiresAt');
    },
  );

  it('wires the redacted boundary into the MCP registry', async () => {
    const tool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_remote_bridge_status',
    );
    if (!tool) throw new Error('remote bridge tool is not registered');

    const result = await tool.handler(
      { action: 'status' },
      {
        token: 'test',
        label: 'test',
        role: 'orchestrator',
        allowedTools: null,
        allowedSkills: null,
        stopAttempts: 0,
        handoffSubmitted: false,
      },
    );

    expect(result).not.toHaveProperty('pairingCode');
    expect(result).not.toHaveProperty('pairingExpiresAt');
  });
});
