import { expect, test, vi } from 'vitest';
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ agentTransport: 'acp', acpHarnessId: 'fixture' }) }));
vi.mock('../acp/harness-store', () => ({ getAcpHarness: () => ({ id: 'fixture', command: '/never-started', args: [], env: {} }) }));
vi.mock('./store-util', () => ({ makeId: (prefix: string) => `${prefix}-fixture` }));
vi.mock('./workspace-path', () => ({ resolveCwdForScope: () => process.cwd() }));
vi.mock('./gate', () => ({ mintToken: vi.fn(), releaseSessionByToken: vi.fn() }));
vi.mock('./agent-identity-spawn', () => ({ issueAgentIdentityBestEffort: vi.fn() }));
vi.mock('./mcp-server', () => ({ getMcpRuntimeInfo: vi.fn() }));
vi.mock('../acp/acp-mcp-stdio-bridge', () => ({ buildAcpMcpStdioServer: vi.fn() }));
import { spawnMainOwnedAcpMissionPane } from './acp-mission-spawn';
import { mintToken } from './gate';
import { issueAgentIdentityBestEffort } from './agent-identity-spawn';
import { getMcpRuntimeInfo } from './mcp-server';

test('refuses an explicit ACP account before identity, MCP or token effects', async () => {
  const mountPane = vi.fn();
  const result = await spawnMainOwnedAcpMissionPane({
    accountId: 'selected-account', missionId: 'mission', role: 'worker', adapterId: 'claude',
    authoritySeal: {}, scope: { rootRealPath: process.cwd() },
  } as never, { attachSessionScope: vi.fn(), panesChanged: vi.fn() }, mountPane);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('account selection is not supported') });
  expect(mintToken).not.toHaveBeenCalled();
  expect(issueAgentIdentityBestEffort).not.toHaveBeenCalled();
  expect(getMcpRuntimeInfo).not.toHaveBeenCalled();
  expect(mountPane).not.toHaveBeenCalled();
});
