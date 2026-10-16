import { describe, expect, it, vi } from 'vitest';

// O módulo em teste importa todos os supervisores de orquestração; o teste só
// exercita o laço do mission-runtime-authority, então os vizinhos são stubs.
vi.mock('./delegation-supervisor', () => ({
  DELEGATION_SCAN_MS: 1_000,
  prepareDelegationSupervisor: vi.fn(),
  reconcileDelegationSupervisor: vi.fn(),
  shutdownDelegationSupervisor: vi.fn(async () => {}),
}));
vi.mock('./login-stuck-watchdog', () => ({
  LOGIN_STUCK_TICK_MS: 1_000,
  installLoginStuckWatchdog: vi.fn(() => async () => {}),
  reconcileLoginStuckWatchdog: vi.fn(),
}));
vi.mock('./boot-prompt-watchdog', () => ({
  BOOT_PROMPT_TICK_MS: 1_000,
  installBootPromptWatchdog: vi.fn(() => () => {}),
  reconcileBootPromptWatchdog: vi.fn(),
}));
vi.mock('./handoff-delivery-outbox', () => ({
  HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS: 1_000,
  reconcilePendingHandoffDeliveryOutbox: vi.fn(async () => {}),
}));
vi.mock('./effect-outbox-worker', () => ({
  registerUnprovenCheckpointHandler: vi.fn(() => () => {}),
  registerDispatchPhysicalSettlementHandler: vi.fn(() => () => {}),
}));
vi.mock('./effect-outbox-maintenance', () => ({ maintainEffectOutboxes: vi.fn(async () => {}) }));
vi.mock('./provider-runtime-recovery', () => ({ reconcileProviderRuntimesAtBoot: vi.fn(() => ({})) }));
vi.mock('./idle-delivery', () => ({ configureHandoffDeliveryRuntimeRecovery: vi.fn() }));
vi.mock('./handoff-delivery-runtime-recovery', () => ({ recoverHandoffDeliveryRuntime: vi.fn() }));
vi.mock('./mission-runtime-termination', () => ({
  terminateUnauthorizedMissionRuntimes: vi.fn(async () => []),
}));
vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: vi.fn(() => { throw new Error('registry não configurado no teste'); }),
}));
vi.mock('./goal-governor', () => ({
  GOAL_GOVERNOR_RECONCILE_CADENCE_MS: 1_000,
  reconcileGoalGovernor: vi.fn(),
  shutdownGoalGovernor: vi.fn(async () => {}),
}));

import { reconcileMissionRuntimeAuthority } from './orchestration-coordinator';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import type { PeriodicTaskContext } from '../observability/periodic-task';

const suite = (name: string): ProjectDomainStoreSuite =>
  ({ scope: { projectId: name } }) as unknown as ProjectDomainStoreSuite;

const ok = () => [{ ok: true, terminatedSessionIds: [] }];

describe('mission-runtime-authority: todas as suites abertas (2 projetos)', () => {
  it('falha no projeto 1 não impede a reconciliação do projeto 2', async () => {
    const project1 = suite('p1');
    const project2 = suite('p2');
    const terminate = vi.fn(async (scope: { projectId: string }) => {
      if (scope.projectId === 'p1') throw new Error('boom projeto 1');
      return ok();
    });
    await expect(
      reconcileMissionRuntimeAuthority(
        { listSuites: () => [project1, project2] },
        undefined,
        terminate as unknown as Parameters<typeof reconcileMissionRuntimeAuthority>[2],
      ),
    ).rejects.toThrow('boom projeto 1');
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith(project2.scope, project2, undefined);
  });

  it('encerramento não provado guarda o PRIMEIRO erro e ainda reconcilia o resto', async () => {
    const terminate = vi.fn(async (scope: { projectId: string }) =>
      scope.projectId === 'p1'
        ? [{ ok: false, terminatedSessionIds: [], error: 'sem prova física' }]
        : ok(),
    );
    await expect(
      reconcileMissionRuntimeAuthority(
        { listSuites: () => [suite('p1'), suite('p2'), suite('p3')] },
        undefined,
        terminate as unknown as Parameters<typeof reconcileMissionRuntimeAuthority>[2],
      ),
    ).rejects.toThrow('sem prova física');
    expect(terminate).toHaveBeenCalledTimes(3);
  });

  it('todas as suites provadas: resolve sem lançar', async () => {
    const terminate = vi.fn(async () => ok());
    await expect(
      reconcileMissionRuntimeAuthority(
        { listSuites: () => [suite('p1'), suite('p2')] },
        undefined,
        terminate as unknown as Parameters<typeof reconcileMissionRuntimeAuthority>[2],
      ),
    ).resolves.toBeUndefined();
  });

  it('abort do próprio passe encerra o laço na hora (não reconcilia o projeto 2)', async () => {
    const checkpoints: string[] = [];
    const context = {
      signal: { aborted: true } as AbortSignal,
      checkpoint: async () => { checkpoints.push('cp'); throw new Error('periodic task aborted'); },
    } as unknown as PeriodicTaskContext;
    const terminate = vi.fn(async () => ok());
    await expect(
      reconcileMissionRuntimeAuthority(
        { listSuites: () => [suite('p1'), suite('p2')] },
        context,
        terminate as unknown as Parameters<typeof reconcileMissionRuntimeAuthority>[2],
      ),
    ).rejects.toThrow('periodic task aborted');
    expect(checkpoints).toHaveLength(1);
    expect(terminate).not.toHaveBeenCalled();
  });
});
