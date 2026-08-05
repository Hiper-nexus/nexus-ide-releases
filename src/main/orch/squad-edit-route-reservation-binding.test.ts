import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { AgentGateContext } from './gate';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

/**
 * P0-2 durable binding regression (Squad Editor slice 1, part d).
 *
 * Locks a path the scout confirmed WORKS but was untested: an EDITED,
 * heterogeneous roster — where the operator changed the executor's CLI/model
 * away from the orchestrator's provider — must flow INTACT into the durable
 * squad→route-reservation binding. The reserved route must carry the EDITED
 * executor's exact cli/model/effort (never collapsing to the Maestro's
 * provider) and stay bound to the mission's sealed squad, so a squad rebind
 * invalidates it. This guards the exact "agêntico ignora squad salvo" /
 * "colapsa num provider só" failure the ledger comment warns against.
 */

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  hasAvailableAccount: vi.fn(),
  warmSquadRuntimeSubscriptionAuth: vi.fn(async () => {}),
}));

vi.mock('../persistence/provider-config-store', async () => {
  const actual = await vi.importActual<
    typeof import('../persistence/provider-config-store')
  >('../persistence/provider-config-store');
  return { ...actual, listProviderSettings: mocks.listProviderSettings };
});

vi.mock('../persistence/account-store', async () => {
  const actual = await vi.importActual<
    typeof import('../persistence/account-store')
  >('../persistence/account-store');
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});

vi.mock('./squad-runtime-inventory', async () => {
  const actual = await vi.importActual<
    typeof import('./squad-runtime-inventory')
  >('./squad-runtime-inventory');
  return {
    ...actual,
    warmSquadRuntimeSubscriptionAuth: mocks.warmSquadRuntimeSubscriptionAuth,
  };
});

import { buildDomainTools } from './tools-domain';

const testDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nexus-squad-edit-binding-'),
);
const scope = testProjectScope({ rootRealPath: testDir });
const SEALED_SQUAD_ID = 'edited-roster-squad';

let runtime: ProjectRuntimeManager;
let missionId = '';

// The Maestro stays on Codex; the operator EDITED the executor onto GLM — a
// different, credentialed provider. The durable binding must preserve that
// heterogeneous edit, never collapsing the executor back onto Codex.
const codexProvider = {
  adapterId: 'codex',
  enabled: true,
  installed: true,
  authStrategy: 'oauth',
  defaultModel: 'gpt-5.6-terra',
  models: ['gpt-5.6-terra'],
};
const glmProvider = {
  adapterId: 'glm',
  enabled: true,
  installed: true,
  authStrategy: 'oauth',
  defaultModel: 'glm-5.2',
  models: ['glm-5.2'],
};

function context(): AgentGateContext {
  return {
    token: 'edited-roster-token',
    sessionId: 'edited-roster-session',
    label: 'Maestro',
    role: 'orchestrator',
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildDomainTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeAll(() => {
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(testDir, 'runtime'),
    appVersion: 'squad-edit-binding-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  const base = compileIntentContract({
    goal: 'Executar a missão com roster editado',
    intentVersion: 1,
  });
  const mission = getProjectDomainStores(scope).missions.create({
    title: 'Roster editado — binding durável',
    squadId: SEALED_SQUAD_ID,
    intentState: 'dispatched',
    intentVersion: 1,
    orchestratorSessionId: 'edited-roster-session',
    intentContract: {
      ...base,
      approvedAt: Date.now(),
      dispatchedAt: Date.now(),
    },
  });
  missionId = mission.id;
  getProjectDomainStores(scope).missions.setStatus(missionId, 'running');

  // The sealed plan carries the EDITED roster: Maestro=codex, executor=glm.
  getProjectDomainStores(scope).tasks.createPlanAtomically({
    missionId,
    intentVersion: 1,
    squad: {
      id: SEALED_SQUAD_ID,
      agents: [
        {
          id: 'maestro',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'codex',
          model: 'gpt-5.6-terra',
        },
        {
          // Operator edit: executor moved off the Maestro's Codex onto GLM.
          id: 'builder',
          agentName: 'Builder',
          category: 'executor',
          cli: 'glm',
          model: 'glm-5.2',
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        plannerId: 'managed',
        title: 'Implementar a correção editada',
        detail: encodeTaskScheduleDetail('Aplicar a correção aprovada.', {
          dependsOn: [],
          ownership: { files: ['src/edited.ts'], symbols: [], domains: [] },
          merged: false,
          agentRef: 'builder',
          agentCategory: 'executor',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'builder',
        agentCategory: 'executor',
      },
    ],
  });
});

beforeEach(() => {
  mocks.listProviderSettings.mockReset();
  mocks.listProviderSettings.mockReturnValue([codexProvider, glmProvider]);
  mocks.hasAvailableAccount.mockReset();
  mocks.hasAvailableAccount.mockReturnValue(true);
  mocks.warmSquadRuntimeSubscriptionAuth.mockClear();
});

afterAll(() => {
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('edited roster → P0-2 durable route-reservation binding', () => {
  it('reserves the EDITED executor cli/model/effort, never the Maestro provider', async () => {
    const decision = (await tool('nexus_route_task').handler(
      { task: 'Implementar a correção editada' },
      context(),
    )) as {
      adapterId: string;
      model?: string;
      effort?: string;
      reason: string;
      routeReservationId?: string;
      routeReservationExpiresAt?: number;
    };

    // The operator's edit survived intact — routed to GLM, not collapsed to
    // the Maestro's Codex.
    expect(decision.adapterId).toBe('glm');
    expect(decision.model).toBe('glm-5.2');
    expect(decision.effort).toBe('high');
    expect(decision.adapterId).not.toBe('codex');
    expect(decision.reason).toContain('roster selado');

    // A durable reservation was minted and bound to the mission's sealed squad.
    expect(decision.routeReservationId).toBeTruthy();
    const persisted = getProjectDomainStores(scope).missions.getRouteReservation(
      decision.routeReservationId!,
    );
    expect(persisted?.decision.adapterId).toBe('glm');
    expect(persisted?.decision.model).toBe('glm-5.2');
    expect(persisted?.decision.effort).toBe('high');
    expect(persisted?.squadId).toBe(SEALED_SQUAD_ID);
  });

  it('keeps the reservation valid while bound, and invalidates it on a squad rebind', () => {
    const stores = getProjectDomainStores(scope);
    const decision = stores.missions.reserveRouteDecision(
      missionId,
      'Implementar a correção editada',
      {
        tier: 'medium',
        adapterId: 'glm',
        model: 'glm-5.2',
        effort: 'high',
        reason: 'roster selado: executor=glm/glm-5.2',
        alternatives: [],
      },
    );
    expect(decision.squadId).toBe(SEALED_SQUAD_ID);

    const expected = {
      reservationId: decision.id,
      missionId,
      adapterId: 'glm',
      model: 'glm-5.2',
      effort: 'high',
    } as const;

    // While the mission stays bound to the sealed (edited) squad, the route the
    // edit produced asserts cleanly.
    expect(
      stores.missions.assertRouteReservation(expected).decision.adapterId,
    ).toBe('glm');

    // Rebinding the mission to a different sealed squad must invalidate the
    // route — the binding is what stops the agêntico path from ignoring the
    // saved (edited) squad and collapsing the heterogeneous roster.
    const current = stores.missions.get(missionId)!;
    const rebound = 'mission-runtime-11111111-1111-4111-8111-111111111111';
    stores.missions.bindMissionRuntimeSquad(missionId, current, rebound);

    expect(() => stores.missions.assertRouteReservation(expected)).toThrow(
      /route_reservation_squad_mismatch/,
    );
  });
});
