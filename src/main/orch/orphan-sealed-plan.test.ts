import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  ORPHAN_SEALED_PLAN_MARKER,
  OrphanSealedPlanError,
  isOrphanSealedPlan,
  orphanSealedPlanMessage,
  sealedPlanPresence,
} from '../../shared/mission-plan-orphan';

/**
 * O TESTE QUE FALTAVA.
 *
 * Estado real de campo: o Main aprovou o plano na VERSÃO 1 da intenção; a
 * missão passou para a VERSÃO 2 quando o objetivo foi aprovado. O plano virou
 * ÓRFÃO. Todo consumidor lia o receipt por (missão, versão CORRENTE), recebia
 * `null` e tratava isso como "esta missão não tem plano" — o ramo LIVRE. Daí o
 * roteador oferecer GLM no lugar do Codex selado, a validação de merge rodar
 * sem vínculo com o plano e o dispatcher devolver a autoridade de execução ao
 * LLM. Nenhum teste cobria o órfão; por isso passou.
 *
 * Este arquivo prova o comportamento nos CONSUMIDORES reais. O contrato de
 * persistência (as três leituras sobre SQLite) vive em `task-store.test.ts`.
 *
 * ATUALIZAÇÃO: a Via Rápida volta a selar o plano das stories listadas
 * (`sealFastLaneListedStoryPlan`). O estado órfão continua coberto; o
 * spawn do Maestro sem PREVC congelado não é bloqueado. Os helpers puros
 * (`sealedPlanPresence`, `OrphanSealedPlanError`) e o gargalo de leitura
 * continuam cobertos aqui porque continuam exportados e vivos.
 */

const scope = testProjectScope();

const SEALED_VERSION = 1;
const LIVE_VERSION = 2;

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  isProviderEnabled: vi.fn(() => true),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  hasAvailableAccount: vi.fn(() => true),
  getProjectDomainStores: vi.fn(),
  liveSquadRuntimeInventory: vi.fn(() => ({
    policy: { routableWorkerCliIds: new Set(['codex', 'glm']) },
  })),
  warmSquadRuntimeSubscriptionAuth: vi.fn(async () => {}),
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: mocks.listProviderSettings,
  isProviderEnabled: mocks.isProviderEnabled,
  providerReadiness: mocks.providerReadiness,
}));

vi.mock('../persistence/account-store', async () => {
  const actual =
    await vi.importActual<typeof import('../persistence/account-store')>(
      '../persistence/account-store',
    );
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});

vi.mock('./project-domain-store-registry', async () => {
  const actual = await vi.importActual<
    typeof import('./project-domain-store-registry')
  >('./project-domain-store-registry');
  return { ...actual, getProjectDomainStores: mocks.getProjectDomainStores };
});

vi.mock('./squad-runtime-inventory', async () => {
  const actual =
    await vi.importActual<typeof import('./squad-runtime-inventory')>(
      './squad-runtime-inventory',
    );
  return {
    ...actual,
    liveSquadRuntimeInventory: mocks.liveSquadRuntimeInventory,
    warmSquadRuntimeSubscriptionAuth: mocks.warmSquadRuntimeSubscriptionAuth,
  };
});

import { buildDomainTools } from './tools-domain';
import {
  assertMainTaskDispatcherAuthority,
  isTaskQueueManagedMission,
  viaRapidaAllowsOrchestratorWorkerSpawn,
} from './task-dispatch-authority';
import { clearRouteLog } from './route-log';
import { clearRouteProvenance } from './route-provenance';

const MISSION_ID = 'mission-orphan-plan';

function mission(intentVersion: number) {
  return {
    id: MISSION_ID,
    title: 'Missão com plano órfão',
    description: 'objetivo aprovado',
    status: 'running',
    squadId: 'delivery-squad',
    milestones: [],
    learnings: '',
    intentState: 'executing',
    intentVersion,
    intentContract: { intentVersion, lane: 'standard', goal: 'objetivo' },
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * Loja de tasks com a MESMA semântica do gargalo real: `getPlanReceipt` da
 * versão corrente NÃO devolve `null` quando existe plano selado noutra versão.
 */
function orphanTasksStore(sealedVersions: readonly number[]) {
  return {
    listPlanIntentVersions: () => [...sealedVersions],
    hasPlan: (_missionId: string, version: number) =>
      sealedVersions.includes(version),
    listPlannedTasks: () => [],
    getPlanReceipt: (missionId: string, version: number) => {
      if (sealedVersions.includes(version)) {
        return { intentVersion: version, tasks: [], agents: [] };
      }
      if (
        sealedPlanPresence({
          missionIntentVersion: version,
          sealedIntentVersions: sealedVersions,
        }) === 'orphan'
      ) {
        throw new OrphanSealedPlanError({
          missionId,
          missionIntentVersion: version,
          sealedIntentVersions: sealedVersions,
        });
      }
      return null;
    },
  };
}

function storesWith(sealedVersions: readonly number[], liveVersion: number) {
  return {
    missions: {
      get: () => mission(liveVersion),
      reserveRouteDecision: () => ({ id: 'reservation', expiresAt: 0 }),
    },
    tasks: orphanTasksStore(sealedVersions),
    missionPanes: { list: () => [] },
  };
}

function context(): AgentGateContext {
  return {
    token: 't',
    label: 'orch',
    role: 'orchestrator',
    scope,
    missionId: MISSION_ID,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  } as AgentGateContext;
}

function tool(name: string) {
  const found = buildDomainTools().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  clearRouteLog();
  clearRouteProvenance();
  mocks.listProviderSettings.mockReset();
  mocks.listProviderSettings.mockReturnValue([
    {
      adapterId: 'glm',
      enabled: true,
      installed: true,
      authStrategy: 'oauth',
      models: ['glm-4.6'],
      defaultModel: 'glm-4.6',
    },
    {
      adapterId: 'codex',
      enabled: true,
      installed: true,
      authStrategy: 'oauth',
      models: ['gpt-5.6-terra'],
      defaultModel: 'gpt-5.6-terra',
    },
  ]);
  mocks.hasAvailableAccount.mockReset();
  mocks.hasAvailableAccount.mockReturnValue(true);
  mocks.getProjectDomainStores.mockReset();
  mocks.warmSquadRuntimeSubscriptionAuth.mockClear();
});

/**
 * As três provas do ROTEADOR sobre plano ÓRFÃO saíram junto com o motor
 * cerimonial: `createPlanAtomically` — o único caminho que gravava
 * `mission_task_plans` — ficou sem nenhum chamador de produção. Sem ninguém
 * selando plano, a missão nunca chega ao estado órfão (selado na v1 enquanto a
 * intenção está na v2), e `nexus_route_task` deixou de consultar roster selado.
 * A divergência de roster continua fechada no DISPATCH (task-dispatch-store).
 */
describe('consumidor ROTEADOR: roteamento sem roster selado', () => {
  it('missão que NUNCA selou plano segue roteando normalmente', async () => {
    mocks.getProjectDomainStores.mockReturnValue(storesWith([], LIVE_VERSION));

    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa qualquer' },
      context(),
    )) as { adapterId: string };

    expect(decision.adapterId).toBeTruthy();
  });

  it('sem missão vinculada a resposta se declara SUGESTÃO, não roster', async () => {
    const unbound = { ...context() };
    delete (unbound as { missionId?: string }).missionId;

    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa qualquer' },
      unbound,
    )) as { reason: string };

    expect(decision.reason).toContain('sugestão livre');
    expect(decision.reason).toContain('nenhum roster selado foi consultado');
  });
});

describe('consumidor DISPATCHER: a autoridade não volta para o LLM', () => {
  it('missão com plano órfão continua gerida pelo motor Nexus', () => {
    const suite = storesWith([SEALED_VERSION], LIVE_VERSION) as never;

    // Antes: hasPlan(missão, v2) === false → o LLM recuperava autoridade de
    // executor exatamente quando a missão estava mais frágil.
    expect(isTaskQueueManagedMission(suite, MISSION_ID)).toBe(true);
    expect(() =>
      assertMainTaskDispatcherAuthority(suite, MISSION_ID, 'spawn de worker'),
    ).toThrow(/task_dispatcher_authority/u);
  });

  it('missão sem plano nenhum continua livre para o orquestrador', () => {
    const suite = storesWith([], LIVE_VERSION) as never;

    expect(isTaskQueueManagedMission(suite, MISSION_ID)).toBe(false);
    expect(() =>
      assertMainTaskDispatcherAuthority(suite, MISSION_ID, 'spawn de worker'),
    ).not.toThrow();
  });

  it('plano na versão corrente continua gerido, como sempre foi', () => {
    const suite = storesWith([LIVE_VERSION], LIVE_VERSION) as never;

    expect(isTaskQueueManagedMission(suite, MISSION_ID)).toBe(true);
  });

  it('Via Rápida (sem PREVC congelado) deixa o Maestro spawnar após o selo', () => {
    expect(
      viaRapidaAllowsOrchestratorWorkerSpawn({
        isTaskQueueManaged: true,
        hasFrozenPrevContract: false,
      }),
    ).toBe(true);
    expect(
      viaRapidaAllowsOrchestratorWorkerSpawn({
        isTaskQueueManaged: true,
        hasFrozenPrevContract: true,
      }),
    ).toBe(false);
    expect(
      viaRapidaAllowsOrchestratorWorkerSpawn({
        isTaskQueueManaged: false,
        hasFrozenPrevContract: false,
      }),
    ).toBe(true);
  });
});

describe('sealedPlanPresence — os três estados deixam de ser um só', () => {
  it('separa nunca-teve / corrente / órfão sem ambiguidade', () => {
    expect(
      sealedPlanPresence({ missionIntentVersion: 2, sealedIntentVersions: [] }),
    ).toBe('none');
    expect(
      sealedPlanPresence({ missionIntentVersion: 2, sealedIntentVersions: [2] }),
    ).toBe('current');
    expect(
      sealedPlanPresence({
        missionIntentVersion: 2,
        sealedIntentVersions: [1, 3],
      }),
    ).toBe('orphan');
  });

  it('a mensagem nomeia as duas versões e o que fazer', () => {
    const message = orphanSealedPlanMessage({
      missionIntentVersion: 2,
      sealedIntentVersions: [1],
    });

    expect(message).toContain(ORPHAN_SEALED_PLAN_MARKER);
    expect(message).toContain('versão 1 da intenção');
    expect(message).toContain('missão está na versão 2');
    expect(message).toContain('Retome a missão para re-selar');
  });

  it('reconhece o órfão mesmo depois de atravessar processo (string)', () => {
    const error = new OrphanSealedPlanError({
      missionIntentVersion: 2,
      sealedIntentVersions: [1],
    });

    expect(isOrphanSealedPlan(error)).toBe(true);
    expect(isOrphanSealedPlan(String(error))).toBe(true);
    expect(isOrphanSealedPlan(new Error('mission not found'))).toBe(false);
  });
});

describe('invariante de código: ninguém contorna o gargalo do plano', () => {
  const ALLOWED_RAW_PLAN_READERS = new Set([
    // Único dono da tabela: é onde o órfão é detectado.
    'src/main/orch/task-store.ts',
    // Leitor do lado do DISPATCH: a versão vem da própria linha de dispatch,
    // nunca da versão viva da missão — e já falha fechado quando a linha não
    // existe. Os três outros donos de dispatch saíram com o motor cerimonial,
    // então a permissão fica ESTRITAMENTE menor.
    'src/main/orch/task-dispatch-store.ts',
  ]);

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return [];
      if (entry.name.includes('.test.')) return [];
      return [full];
    });
  }

  it('nenhum consumidor novo lê mission_task_plans por fora da loja', () => {
    const root = path.resolve(__dirname, '../../..');
    const offenders = sourceFiles(path.join(root, 'src'))
      .filter((file) => {
        if (file.includes(`${path.sep}runtime${path.sep}`)) return false;
        return fs.readFileSync(file, 'utf8').includes('mission_task_plans');
      })
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED_RAW_PLAN_READERS.has(file));

    // Um leitor novo desta tabela é um lugar novo onde o órfão pode voltar a
    // se disfarçar de "sem plano". Se este teste falhar, decida explicitamente.
    expect(offenders).toEqual([]);
  });
});
