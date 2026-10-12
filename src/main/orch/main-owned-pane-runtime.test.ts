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
  missionCurrent: true,
  missionDescription: '',
  policy: 'governed' as 'governed' | 'operator-choice',
  transport: 'pty' as 'pty' | 'acp',
  acpSpawn: vi.fn(),
  authoritative: vi.fn<(...args: unknown[]) => Promise<ProviderSpawnPreparation>>(),
  acquirePermit: vi.fn(async (_adapterId: string): Promise<() => void> => () => {}),
  settle: vi.fn<(adapter: unknown) => Promise<void> | null | undefined>(),
  copyConversation: vi.fn(() => true),
  continuationBind: vi.fn(),
  continuationAssert: vi.fn(),
  continuationAccount: vi.fn(),
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
vi.mock('./mission-pane-resume-ownership', () => ({
  bindWorkerContinuationTarget: deps.continuationBind, assertWorkerContinuationTarget: deps.continuationAssert,
  assertWorkerContinuationAccount: deps.continuationAccount,
  workerContinuationPhysicalProof: () => vi.fn(), bindWorkerContinuationSession: vi.fn(), authorizeWorkerContinuationBirth: vi.fn(),
}));
vi.mock('./codex-cli-version', () => ({ settleCodexCliVersionForSpawn: deps.settle }));
vi.mock('../adapters/managed-credentials', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/managed-credentials')>(),
  trackManagedSession: deps.track,
}));
vi.mock('../persistence/account-choice-receipts', () => ({ recordAccountChoiceReceipt: vi.fn() }));
vi.mock('../persistence/provider-session-store', async original => ({
  ...await original<typeof import('../persistence/provider-session-store')>(),
  copyProviderPaneSession: deps.copyConversation,
}));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn(), getSessionState: () => 'spawning', spawnMainOwnedAgentSession: deps.spawn,
  isOneShotSessionRunning: () => false,
}));
vi.mock('../pty/autonomous-cli-policy', () => ({
  isMissionBoundCodexWorkspaceAuthority: () => false,
  requiresReadOnlyNativeAuthority: () => false,
  supportsEnforceableReadOnlyNativeAuthority: () => true,
  supportsEnforceableWorkspaceWriteNativeAuthority: () => true,
}));
vi.mock('../pty/trusted-native-cli-binary', () => ({ assertTrustedNativeConfinementBinary: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ squadCliPolicy: deps.policy, agentTransport: deps.transport }) }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: () => ({ missions: { get: () => ({
  id: 'synthetic-mission', description: deps.missionDescription, status: deps.missionCurrent ? 'running' : 'blocked', intentState: deps.missionCurrent ? 'executing' : 'blocked_user',
  intentVersion: 1, intentContract: { goal: 'Authorized mission', intentVersion: 1, approvedAt: 1 },
}) } }) }));
vi.mock('./workspace-path', () => ({ resolveCwdForScope: () => '/synthetic/workspace' }));
vi.mock('./mission-pane-authority', () => ({ sameMissionPaneAuthoritySeal: vi.fn() }));
vi.mock('./acp-mission-spawn', () => ({ spawnMainOwnedAcpMissionPane: deps.acpSpawn }));
vi.mock('./agent-identity-spawn', () => ({ issueAgentIdentityBestEffort: vi.fn() }));

import { deleteMainOwnedPane, getMainOwnedPane, setMainOwnedPane, spawnMainOwnedMissionPane, spawnMainOwnedMissionPaneAsync } from './main-owned-pane-runtime';

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
  deps.missionCurrent = true; deps.missionDescription = ''; deps.policy = 'governed'; deps.transport = 'pty';
  deps.authoritative.mockResolvedValue({ ok: true, overrides });
  deps.acquirePermit.mockReset().mockResolvedValue(() => {});
  deps.copyConversation.mockReturnValue(true);
});

describe('exact headless mission resume', () => {
  function deferredGuard(): () => void {
    const call = deps.spawn.mock.calls.at(-1) as unknown as [unknown, unknown, { assertDeferredSpawnCurrent?: () => void }];
    expect(call[2].assertDeferredSpawnCurrent).toBeTypeOf('function');
    return call[2].assertDeferredSpawnCurrent!;
  }

  it('F-1151: rotating auth wait reentry keeps the already bound continuation tuple', async () => {
    const continuation = { sourcePaneId: 'closed-original', attemptId: 'exact-attempt' };
    deps.continuationBind.mockImplementationOnce(() => {}).mockImplementation(() => {
      throw new Error('continuation already bound');
    });
    const result = await spawnMainOwnedMissionPaneAsync({ ...options, workerContinuation: continuation,
      resume: true, resumeFromPaneId: continuation.sourcePaneId }, hooks);
    expect(result.ok).toBe(true);
    expect(deps.continuationBind).toHaveBeenCalledTimes(1);
    const bound = deps.continuationBind.mock.calls[0][2];
    expect(result).toMatchObject({ requestId: bound.requestId, paneId: bound.paneId });
    expect(deps.continuationAssert).toHaveBeenCalledWith(options.scope, continuation, bound);
    deleteMainOwnedPane(result.paneId!);
  });

  it('F-1151: the selected physical account is fenced against the original pin before any headless child exists', async () => {
    const continuation = { sourcePaneId: 'closed-original', attemptId: 'exact-attempt' };
    const resumed = { ...options, workerContinuation: continuation, resume: true, resumeFromPaneId: continuation.sourcePaneId };
    deps.continuationAccount.mockClear();
    // The account Main will physically use is what the fence receives, not the (absent) request pin.
    deps.prepare.mockReturnValue({ ok: true, overrides: { ...overrides, selectedAccountId: 'account-selected' } });
    await spawnMainOwnedMissionPaneAsync(resumed, hooks).then(result => deleteMainOwnedPane(result.paneId!));
    // Idempotent read-only fence: it also runs again on the rotating-auth re-entry.
    expect(deps.continuationAccount).toHaveBeenCalled();
    expect(deps.continuationAccount.mock.calls.every(call => call[0] === options.scope && call[1] === continuation && call[2] === 'account-selected')).toBe(true);
    deps.spawn.mockClear();
    deps.continuationAccount.mockImplementationOnce(() => {
      throw new Error('resume_authority_changed: a conta selecionada difere da conta original do worker');
    });
    const refused = await spawnMainOwnedMissionPaneAsync(resumed, hooks);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/conta selecionada/) });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('accepts only the exact Main reservation after a deferred spawn handle is published', async () => {
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    const guard = deferredGuard();
    expect(() => guard()).not.toThrow();
    const record = getMainOwnedPane(result.paneId!)!;
    record.entry.sessionId = 'replacement-from-another-operation';
    expect(() => guard()).toThrow(/reservation/i);
    deleteMainOwnedPane(result.paneId!);
  });

  it('denies deferred physical birth after the reserved pane is closed', async () => {
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    const guard = deferredGuard();
    deleteMainOwnedPane(result.paneId!);
    expect(() => guard()).toThrow(/reservation/i);
  });

  it('rejects a different Main record even when the pane and session IDs were reused', async () => {
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    const guard = deferredGuard();
    const record = getMainOwnedPane(result.paneId!)!;
    setMainOwnedPane(result.paneId!, { entry: { ...record.entry }, meta: { ...record.meta } });
    expect(() => guard()).toThrow(/reservation/i);
    deleteMainOwnedPane(result.paneId!);
  });

  it('transfers dispatch to the exact published reservation when presentation retires the ended origin', async () => {
    let originCurrent = true;
    const result = await spawnMainOwnedMissionPaneAsync({ ...options,
      assertOriginCurrent: () => { if (!originCurrent) throw new Error('deferred origin closed'); },
    }, hooks);
    expect(result.ok).toBe(true);
    const guard = deferredGuard();
    expect(() => guard()).not.toThrow();
    originCurrent = false;
    expect(() => guard()).not.toThrow();
    deleteMainOwnedPane(result.paneId!);
    expect(() => guard()).toThrow(/reservation/i);
  });

  it('denies a deferred dispatch when reservation publication failed after handle allocation', async () => {
    const result = await spawnMainOwnedMissionPaneAsync(options, {
      ...hooks, attachSessionScope: () => { throw new Error('scope attachment failed'); },
    });
    expect(result).toMatchObject({ ok: false, error: 'scope attachment failed' });
    expect(() => deferredGuard()()).toThrow(/reservation/i);
  });

  it('revalidates sealed mission authority after deferred readiness', async () => {
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    const guard = deferredGuard();
    expect(() => guard()).not.toThrow();
    deps.assertCurrent.mockImplementation(() => { throw new Error('mission changed during readiness'); });
    expect(() => guard()).toThrow('mission changed during readiness');
    deleteMainOwnedPane(result.paneId!);
  });

  it('F-886 revalidates Main origin after provider preparation before the physical spawn', async () => {
    deps.adapterId = 'claude';
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    deps.authoritative.mockImplementationOnce(async () => { entered(); await blocked; return { ok: true, overrides }; });
    let current = true;
    const result = spawnMainOwnedMissionPaneAsync({ ...options, adapterId: 'claude', role: 'orchestrator',
      assertOriginCurrent: () => { if (!current) throw new Error('origin pane closed'); },
    }, hooks);
    await started;
    current = false;
    release();
    await expect(result).resolves.toMatchObject({ ok: false, error: 'origin pane closed' });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('F-886 revalidates Main origin after the CLI permit wait', async () => {
    let grant!: (value: () => void) => void;
    const release = vi.fn();
    deps.acquirePermit.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    let current = true;
    const result = spawnMainOwnedMissionPaneAsync({ ...options,
      assertOriginCurrent: () => { if (!current) throw new Error('origin pane replaced'); },
    }, hooks);
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    grant(release);
    await expect(result).resolves.toMatchObject({ ok: false, error: 'origin pane replaced' });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it('copies the recorded conversation and sends the exact-resume flag to the physical PTY', async () => {
    const result = await spawnMainOwnedMissionPaneAsync({ ...options, resume: true, resumeFromPaneId: 'pane-original' }, hooks);
    expect(result.ok).toBe(true);
    expect(deps.copyConversation).toHaveBeenCalledWith(options.scope, 'pane-original', result.paneId, 'codex', undefined, undefined);
    expect(deps.spawn).toHaveBeenCalledWith(expect.objectContaining({ resume: true }), expect.anything(), expect.anything(),
      expect.objectContaining({ context: expect.objectContaining({ exactResumeRequired: true }) }));
  });
  it('never creates a fresh process when the original conversation cannot be copied', async () => {
    deps.copyConversation.mockReturnValue(false);
    await expect(spawnMainOwnedMissionPaneAsync({ ...options, resume: true, resumeFromPaneId: 'pane-original' }, hooks))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('resume_context_unavailable') });
    expect(deps.spawn).not.toHaveBeenCalled();
  });
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
    expect(deps.spawn).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining(overrides), expect.anything());
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


describe('F-429 — Main Autopilot spawn cannot outlive Stop', () => {
  it('refuses a running legacy row whose latest verdict still records operator Stop', async () => {
    deps.policy = 'operator-choice';
    deps.missionDescription = '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Encerrada.';
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    try { expect(result.ok).toBe(false); expect(deps.spawn).not.toHaveBeenCalled(); }
    finally { if (result.paneId) deleteMainOwnedPane(result.paneId); }
  });
  it('allows current dispatch after a later verdict supersedes the historical close marker', async () => {
    deps.policy = 'operator-choice';
    deps.missionDescription = '<!-- nexus:runtime-closed -->\nEncerrada.\n<!-- nexus:agent-status-block -->\nBloqueio posterior.';
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    try { expect(result.ok).toBe(true); }
    finally { if (result.paneId) deleteMainOwnedPane(result.paneId); }
  });

  it.each([true, false])('keeps active Autopilot roster freedom with sealed=%s', async sealed => {
    deps.policy = 'operator-choice';
    deps.assertCurrent.mockImplementation(() => { throw new Error('roster changed, dispatch still approved'); });
    const result = await spawnMainOwnedMissionPaneAsync({ ...options, authoritySeal: sealed ? options.authoritySeal : undefined }, hooks);
    try {
      expect(result.ok).toBe(true);
      const call = deps.spawn.mock.calls.at(-1) as unknown as [unknown, unknown, { assertDeferredSpawnCurrent: () => void }];
      expect(() => call[2].assertDeferredSpawnCurrent()).not.toThrow();
      deps.missionCurrent = false;
      expect(() => call[2].assertDeferredSpawnCurrent()).toThrow(/mission.*authorized/);
    } finally { if (result.paneId) deleteMainOwnedPane(result.paneId); }
  });

  it.each(['authentication', 'permit'])('rechecks dispatch after pending %s without changing CLI choice', async waitingOn => {
    deps.policy = 'operator-choice'; deps.adapterId = 'claude';
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn();
    if (waitingOn === 'authentication') deps.authoritative.mockImplementationOnce(async () => { await blocked; return { ok: true, overrides }; });
    else deps.acquirePermit.mockImplementationOnce(async () => { await blocked; return release; });
    deps.assertCurrent.mockImplementation(() => { if (!deps.missionCurrent) throw new Error('mission stopped'); });
    const pending = spawnMainOwnedMissionPaneAsync({ ...options, adapterId: 'claude', role: 'orchestrator' }, hooks);
    await vi.waitFor(() => expect(waitingOn === 'authentication' ? deps.authoritative : deps.acquirePermit).toHaveBeenCalled());
    deps.missionCurrent = false; finish();
    const result = await pending;
    try {
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/mission.*(?:stopped|authorized)/) });
      expect(deps.spawn).not.toHaveBeenCalled();
      if (waitingOn === 'permit') expect(release).toHaveBeenCalledOnce();
    } finally { if (result.paneId) deleteMainOwnedPane(result.paneId); }
  });

  it('rechecks dispatch at deferred physical birth in Autopilot', async () => {
    deps.policy = 'operator-choice';
    const result = await spawnMainOwnedMissionPaneAsync(options, hooks);
    expect(result.ok).toBe(true);
    const call = deps.spawn.mock.calls.at(-1) as unknown as [unknown, unknown, { assertDeferredSpawnCurrent: () => void }];
    deps.missionCurrent = false;
    try { expect(() => call[2].assertDeferredSpawnCurrent()).toThrow(/mission.*authorized/); }
    finally { deleteMainOwnedPane(result.paneId!); }
  });

  it('carries the dispatch fence to ACP before its asynchronous imports finish', async () => {
    deps.policy = 'operator-choice'; deps.transport = 'acp';
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const physicalSpawn = vi.fn();
    deps.acpSpawn.mockImplementationOnce(async (input: PaneSpawnOptions) => {
      await blocked;
      try { input.assertOriginCurrent?.(); physicalSpawn(); return { requestId: 'acp-test', ok: true }; }
      catch (error) { return { requestId: 'acp-test', ok: false, error: String(error) }; }
    });
    const pending = spawnMainOwnedMissionPaneAsync(options, hooks);
    await vi.waitFor(() => expect(deps.acpSpawn).toHaveBeenCalled());
    deps.missionCurrent = false; finish();
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/mission.*authorized/) });
    expect(physicalSpawn).not.toHaveBeenCalled();
  });
});
