import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSpawnPreparation } from '../persistence/provider-config-store';
import type { MainOwnedPaneHooks, PaneSpawnOptions } from './main-owned-pane-runtime';

const deps = vi.hoisted(() => ({
  prepare: vi.fn<(...args: unknown[]) => ProviderSpawnPreparation>(),
  gate: vi.fn<(...args: unknown[]) => Promise<string>>(),
  spawn: vi.fn(() => ({ sessionId: 'synthetic-codex-session' })),
  assertCurrent: vi.fn(),
  track: vi.fn(),
  adapterId: 'codex',
  authoritative: vi.fn<(...args: unknown[]) => Promise<ProviderSpawnPreparation>>(),
  acquirePermit: vi.fn(async (_adapterId: string): Promise<() => void> => () => {}),
  liveClaudeAccounts: vi.fn(() => [] as string[]),
  settle: vi.fn<(adapter: unknown) => Promise<void> | null | undefined>(),
}));

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: () => ({
    kind: 'cli-pty', id: deps.adapterId, label: 'Codex', bin: 'codex',
    quirks: { mcpAutoload: false }, env: { passthrough: [], ephemeralHome: false },
    control: {}, install: { command: 'install codex' },
  }),
  isAdapterInstalled: () => true,
  isBuiltinAdapter: () => true,
  resolveAdapterBinary: () => '/synthetic/bin/codex',
}));
vi.mock('../persistence/provider-config-store', () => ({
  prepareProviderSpawn: deps.prepare,
  prepareProviderSpawnAuthoritative: deps.authoritative,
  acquireCliSpawnPermit: deps.acquirePermit,
}));
vi.mock('../adapters/managed-auth-spawn-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/managed-auth-spawn-gate')>(),
  waitForRotatingAuthSpawnGate: deps.gate,
}));
vi.mock('./codex-cli-version', () => ({ settleCodexCliVersionForSpawn: deps.settle }));
vi.mock('../adapters/managed-credentials', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/managed-credentials')>(),
  trackManagedSession: deps.track,
}));
vi.mock('../persistence/account-choice-receipts', () => ({ recordAccountChoiceReceipt: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn(), getSessionState: () => 'spawning', spawnMainOwnedAgentSession: deps.spawn,
  liveClaudeMissionAccountIds: deps.liveClaudeAccounts,
}));
vi.mock('../pty/autonomous-cli-policy', () => ({
  isMissionBoundCodexWorkspaceAuthority: () => false,
  requiresReadOnlyNativeAuthority: () => false,
  supportsEnforceableReadOnlyNativeAuthority: () => true,
  supportsEnforceableWorkspaceWriteNativeAuthority: () => true,
}));
vi.mock('../pty/trusted-native-cli-binary', () => ({ assertTrustedNativeConfinementBinary: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ squadCliPolicy: 'governed', agentTransport: 'pty' }) }));
vi.mock('./workspace-path', () => ({ resolveCwdForScope: () => '/synthetic/workspace' }));
vi.mock('./mission-pane-authority', () => ({ sameMissionPaneAuthoritySeal: vi.fn() }));
vi.mock('./acp-mission-spawn', () => ({ spawnMainOwnedAcpMissionPane: vi.fn() }));
vi.mock('./agent-identity-spawn', () => ({ issueAgentIdentityBestEffort: vi.fn() }));

import { getMainOwnedPane, spawnMainOwnedMissionPane, spawnMainOwnedMissionPaneAsync } from './main-owned-pane-runtime';

const options: PaneSpawnOptions & { missionId: string; role: 'worker' } = {
  adapterId: 'codex', missionId: 'synthetic-mission', role: 'worker',
  scope: {
    version: 1, installationId: 'installation', projectId: 'project', checkoutId: 'checkout',
    rootRealPath: '/synthetic/workspace', identitySource: 'manifest',
  },
  authoritySeal: {
    intentVersion: 1, intentContractHash: 'intent', contextRevision: 'revision',
    contractHash: 'contract', squadRevisionHash: 'squad',
  },
};
const hooks: MainOwnedPaneHooks = {
  attachSessionScope: vi.fn(), panesChanged: vi.fn(), assertMissionAuthorityCurrent: deps.assertCurrent,
};
const overrides = { binPath: '/synthetic/bin/codex', keyEnv: { CODEX_HOME: '/synthetic/account-a' }, defaultModel: null, extraArgs: [], suppressEnv: [] };

beforeEach(() => {
  vi.resetAllMocks();
  deps.spawn.mockReturnValue({ sessionId: 'synthetic-codex-session' });
  deps.prepare.mockReturnValue({ ok: true, overrides });
  deps.gate.mockResolvedValue('fresh');
  deps.adapterId = 'codex';
  deps.authoritative.mockResolvedValue({ ok: true, overrides });
  deps.acquirePermit.mockReset().mockResolvedValue(() => {});
});

describe('F-790: spawn do Codex aguarda a sonda de versão (teto curto)', () => {
  it('Codex com a sonda em voo: nada é preparado nem spawnado até ela concluir', async () => {
    let finish!: () => void;
    deps.settle.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = spawnMainOwnedMissionPaneAsync(options, hooks);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex', bin: 'codex' }));
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.acquirePermit).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true, sessionId: 'synthetic-codex-session' });
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it('sem nada a esperar (null) o spawn segue direto — outras CLIs nunca esperam', async () => {
    deps.adapterId = 'claude';
    deps.settle.mockReturnValue(null);
    const pending = spawnMainOwnedMissionPaneAsync({ ...options, adapterId: 'claude', role: 'orchestrator' }, hooks);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude' }));
    expect(deps.spawn).toHaveBeenCalledOnce();
  });
});

describe('main-owned Codex auth gate', () => {
  it('requires the async identity boundary for direct main-owned Claude spawns', () => {
    deps.adapterId = 'claude';
    expect(spawnMainOwnedMissionPane({ ...options, adapterId: 'claude', role: 'orchestrator' }, hooks))
      .toMatchObject({ ok: false, error: expect.stringContaining('async') });
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('checks managed Claude identity before spawning a mission pane', async () => {
    deps.adapterId = 'claude';
    deps.authoritative.mockResolvedValueOnce({ ok: false, error: 'credencial de outra conta Claude' });
    await expect(spawnMainOwnedMissionPaneAsync({ ...options, adapterId: 'claude', role: 'orchestrator' }, hooks))
      .resolves.toMatchObject({ ok: false, error: 'credencial de outra conta Claude' });
    expect(deps.authoritative).toHaveBeenCalledOnce();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('F-235: worker Claude passa as contas com pane vivo da missão ao prepare', async () => {
    deps.adapterId = 'claude';
    deps.liveClaudeAccounts.mockReturnValue(['acct-A']);

    await expect(
      spawnMainOwnedMissionPaneAsync(
        { ...options, adapterId: 'claude', role: 'worker', readOnly: true },
        hooks,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(deps.liveClaudeAccounts).toHaveBeenCalledWith('synthetic-mission');
    expect(deps.authoritative).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ excludeAccountIds: ['acct-A'] }),
    );
  });
  it('waits for the Claude update permit before physical main-owned spawn', async () => {
    deps.adapterId = 'claude';
    const release = vi.fn();
    let grant!: (value: () => void) => void;
    deps.acquirePermit.mockImplementationOnce(() =>
      new Promise<() => void>((resolve) => { grant = resolve; }));

    const pending = spawnMainOwnedMissionPaneAsync({ ...options, adapterId: 'claude', role: 'orchestrator' }, hooks);
    await Promise.resolve();
    expect(deps.spawn).not.toHaveBeenCalled();

    grant(release);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(deps.acquirePermit).toHaveBeenCalledWith('claude');
    expect(release).toHaveBeenCalledOnce();
  });
  it('waits on the prepared account before creating a physical pane and never reselects it', async () => {
    let release!: () => void;
    deps.gate.mockImplementationOnce(async () => {
      expect(deps.prepare).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => { release = resolve; });
      return 'follower-fresh';
    });
    const result = spawnMainOwnedMissionPaneAsync(options, hooks);
    await Promise.resolve();
    expect(deps.gate).toHaveBeenCalledWith({ authFile: '/synthetic/account-a/auth.json' });
    expect(deps.spawn).not.toHaveBeenCalled();
    deps.prepare.mockReturnValue({ ok: true, overrides: { ...overrides, keyEnv: { CODEX_HOME: '/synthetic/account-b' } } });
    release();
    await expect(result).resolves.toMatchObject({ ok: true, sessionId: 'synthetic-codex-session' });
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.spawn).toHaveBeenCalledWith(expect.anything(), expect.anything(), overrides, expect.anything());
  });

  it('retains the actual selected account in session metadata and credential tracking', async () => {
    deps.prepare.mockReturnValue({ ok: true, overrides: { ...overrides, selectedAccountId: 'account-selected' } });
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    expect(deps.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-selected' }),
      expect.anything(), expect.anything(), expect.anything(),
    );
    expect(deps.track).toHaveBeenCalledWith('synthetic-codex-session', 'codex', 'account-selected');
    expect(getMainOwnedPane(result.paneId!)?.entry.accountId).toBe('account-selected');
    expect(options.accountId).toBeUndefined();
  });

  it('rejects preparation that changes an explicit account pin', async () => {
    deps.prepare.mockReturnValue({ ok: true, overrides: { ...overrides, selectedAccountId: 'account-other' } });
    const result = await spawnMainOwnedMissionPaneAsync({ ...options, accountId: 'account-pinned' }, hooks);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/selected account.*pin/i) });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.track).not.toHaveBeenCalled();
  });

  it('reports refresh timeout without creating a physical pane', async () => {
    deps.gate.mockRejectedValueOnce(new Error('Codex auth refresh timed out; retry shortly'));
    await expect(spawnMainOwnedMissionPaneAsync(options, hooks)).resolves.toMatchObject({ ok: false, error: 'Codex auth refresh timed out; retry shortly' });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('rejects authority revoked while the auth gate was waiting', async () => {
    let release!: () => void;
    deps.gate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'follower-fresh';
    });
    const result = spawnMainOwnedMissionPaneAsync(options, hooks);
    await Promise.resolve();
    expect(deps.spawn).not.toHaveBeenCalled();
    deps.assertCurrent.mockImplementation(() => { throw new Error('mission authority revoked during auth wait'); });
    release();
    await expect(result).resolves.toMatchObject({ ok: false, error: 'mission authority revoked during auth wait' });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('rejects invalid Main authority before materializing account credentials', async () => {
    deps.assertCurrent.mockImplementation(() => { throw new Error('mission authority revoked'); });
    await expect(spawnMainOwnedMissionPaneAsync(options, hooks)).resolves.toMatchObject({
      ok: false, error: 'mission authority revoked',
    });
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('reports account preparation failure without entering the auth gate', async () => {
    deps.prepare.mockReturnValue({ ok: false, error: 'account unavailable' });
    await expect(spawnMainOwnedMissionPaneAsync(options, hooks)).resolves.toMatchObject({ ok: false, error: 'account unavailable' });
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
});
