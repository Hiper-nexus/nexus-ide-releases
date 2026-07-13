import { describe, expect, it } from 'vitest';
import {
  decideDriveAction,
  defaultDriveConfig,
  deriveDriveState,
  driveBackoffMs,
  type DriveConfig,
  type DriveState,
  type DriveStateInputs,
} from './mission-drive';
import type { MissionMilestone } from '../../shared/orch-types';

const CONFIG: DriveConfig = defaultDriveConfig;

const NOW = new Date('2026-07-13T12:00:00Z').getTime();

function baseRunning(overrides: Partial<DriveState> = {}): DriveState {
  return {
    missionId: 'm1',
    missionStatus: 'running',
    lastProgressAt: NOW - 60_000,
    steps: [],
    trustedEvidenceReadyForCurrent: false,
    allStepsDone: false,
    completionVerified: false,
    contextRot: false,
    paneDead: false,
    accountFailed: false,
    iteration: 0,
    startedAt: NOW - 60_000,
    stallSignalCount: 0,
    ...overrides,
  };
}

describe('decideDriveAction', () => {
  it('espera (wait) quando a missão não está running', () => {
    const nonRunning = ['pending', 'blocked', 'done', 'failed'] as const;
    for (const status of nonRunning) {
      const state = baseRunning({
        missionStatus: status,
        lastProgressAt: NOW - 30 * 60_000,
      });
      expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('wait');
    }
  });

  it('espera quando está running mas houve progresso recente', () => {
    const state = baseRunning({ lastProgressAt: NOW - 60_000 });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('wait');
  });

  it('sinaliza stall quando running e silencioso por >= stallMs (boundary inclusivo)', () => {
    const atLimit = baseRunning({ lastProgressAt: NOW - CONFIG.stallMs });
    expect(decideDriveAction(atLimit, NOW, CONFIG).kind).toBe('signal-stall');

    const beyond = baseRunning({
      lastProgressAt: NOW - CONFIG.stallMs - 1,
    });
    expect(decideDriveAction(beyond, NOW, CONFIG).kind).toBe('signal-stall');
  });

  it('não re-sinaliza stall antes do intervalo de debounce', () => {
    const state = baseRunning({
      lastProgressAt: NOW - 30 * 60_000,
      lastStallSignalAt: NOW - 60_000,
    });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('wait');
  });

  it('re-sinaliza stall após o intervalo de debounce', () => {
    const state = baseRunning({
      lastProgressAt: NOW - 30 * 60_000,
      lastStallSignalAt: NOW - CONFIG.stallResignalMs - 1,
    });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('signal-stall');
  });

  it('trata lastProgressAt futuro (clock skew) como wait — não mascara nem vira spam', () => {
    const state = baseRunning({ lastProgressAt: NOW + 60_000 });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('wait');
    if (action.kind === 'wait') {
      expect(action.reason).toContain('clock skew');
    }
  });

  it('trata lastProgressAt NaN como wait — não cai no path signal-stall', () => {
    const state = baseRunning({ lastProgressAt: Number.NaN });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('wait');
  });

  it('signal-stall carrega há quanto tempo está silencioso', () => {
    const state = baseRunning({ lastProgressAt: NOW - 12 * 60_000 });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('signal-stall');
    if (action.kind === 'signal-stall') {
      expect(action.silentForMs).toBe(12 * 60_000);
    }
  });

  it('block-human quando maxIterations esgotado', () => {
    const state = baseRunning({ iteration: CONFIG.maxIterations });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('block-human');
    if (action.kind === 'block-human') {
      expect(action.reason).toContain('maxIterations');
    }
  });

  it('block-human quando maxWallClockMs esgotado', () => {
    const state = baseRunning({
      startedAt: NOW - CONFIG.maxWallClockMs - 1,
      lastProgressAt: NOW - 1_000,
    });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('block-human');
    if (action.kind === 'block-human') {
      expect(action.reason).toContain('maxWallClockMs');
    }
  });

  it('complete quando todas as etapas estão done via PREVC', () => {
    const state = baseRunning({
      steps: [
        {
          id: 's1',
          label: 'A',
          status: 'done',
          evidenceIds: ['e1'],
          trustedEvidenceReady: true,
        },
      ],
      allStepsDone: true,
      completionVerified: true,
      lastProgressAt: NOW - 1_000,
    });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('complete');
  });

  it('complete prevalece quando o último avanço consumiu exatamente o budget', () => {
    const completeAtBoundary = baseRunning({
      steps: [{
        id: 's1',
        label: 'A',
        status: 'done',
        evidenceIds: ['e1'],
        trustedEvidenceReady: true,
      }],
      allStepsDone: true,
      completionVerified: true,
      iteration: CONFIG.maxIterations,
      startedAt: NOW - CONFIG.maxWallClockMs,
    });

    expect(decideDriveAction(completeAtBoundary, NOW, CONFIG).kind).toBe('complete');
  });

  it('bloqueia finitamente quando milestones done não possuem receipts válidos', () => {
    const invalidCompletion = baseRunning({
      steps: [{
        id: 's1',
        label: 'A',
        status: 'done',
        evidenceIds: ['e1'],
        trustedEvidenceReady: true,
      }],
      allStepsDone: true,
      completionVerified: false,
      iteration: CONFIG.maxIterations + 100,
    });

    const action = decideDriveAction(invalidCompletion, NOW, CONFIG);
    expect(action.kind).toBe('block-human');
    expect(action.reason).toMatch(/receipts are incomplete/i);
  });

  it('re-route quando accountFailed', () => {
    const state = baseRunning({
      accountFailed: true,
      lastProgressAt: NOW - 1_000,
    });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('re-route');
  });

  it('respawn-fresh-context quando paneDead ou contextRot', () => {
    expect(
      decideDriveAction(
        baseRunning({ paneDead: true, lastProgressAt: NOW - 1_000 }),
        NOW,
        CONFIG,
      ).kind,
    ).toBe('respawn-fresh-context');
    expect(
      decideDriveAction(
        baseRunning({ contextRot: true, lastProgressAt: NOW - 1_000 }),
        NOW,
        CONFIG,
      ).kind,
    ).toBe('respawn-fresh-context');
  });

  it('advance quando trusted evidence pronta para o step atual', () => {
    const state = baseRunning({
      steps: [
        {
          id: 's1',
          label: 'A',
          status: 'in-progress',
          evidenceIds: ['e1'],
          trustedEvidenceReady: true,
        },
      ],
      currentStepId: 's1',
      trustedEvidenceReadyForCurrent: true,
      lastProgressAt: NOW - 1_000,
    });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('advance');
    if (action.kind === 'advance') {
      expect(action.stepId).toBe('s1');
    }
  });

  it('block-human em stall crônico (stallSignalCount >= chronicStallCount)', () => {
    const state = baseRunning({
      lastProgressAt: NOW - CONFIG.stallMs - 1,
      stallSignalCount: CONFIG.chronicStallCount,
    });
    const action = decideDriveAction(state, NOW, CONFIG);
    expect(action.kind).toBe('block-human');
    if (action.kind === 'block-human') {
      expect(action.reason).toContain('chronic stall');
    }
  });

  it('budget tem prioridade sobre advance (exhausted → block-human)', () => {
    const state = baseRunning({
      iteration: CONFIG.maxIterations,
      currentStepId: 's1',
      trustedEvidenceReadyForCurrent: true,
    });
    expect(decideDriveAction(state, NOW, CONFIG).kind).toBe('block-human');
  });

  it('enforces exponential backoff after lastActionAt (pure core, not only tick interval)', () => {
    // iteration 3 → backoff 8s with base 1s; last action 1s ago → wait
    const state = baseRunning({
      lastProgressAt: NOW - CONFIG.stallMs - 1,
      iteration: 3,
      lastActionAt: NOW - 1_000,
    });
    const action = decideDriveAction(state, NOW, {
      ...CONFIG,
      baseBackoffMs: 1_000,
    });
    expect(action.kind).toBe('wait');
    if (action.kind === 'wait') {
      expect(action.reason).toContain('exponential backoff');
    }
  });

  it('allows non-wait after backoff window has elapsed', () => {
    const state = baseRunning({
      lastProgressAt: NOW - CONFIG.stallMs - 1,
      iteration: 1,
      lastActionAt: NOW - 10_000, // base 1s → backoff 2s; 10s elapsed
    });
    expect(
      decideDriveAction(state, NOW, { ...CONFIG, baseBackoffMs: 1_000 }).kind,
    ).toBe('signal-stall');
  });

  it('complete bypasses exponential backoff (terminal path)', () => {
    const state = baseRunning({
      lastProgressAt: NOW - 1_000,
      iteration: 5,
      lastActionAt: NOW - 100, // deep inside backoff
      allStepsDone: true,
      completionVerified: true,
      steps: [
        {
          id: 's1',
          label: 'A',
          status: 'done',
          evidenceIds: ['e1'],
          trustedEvidenceReady: true,
        },
      ],
    });
    expect(
      decideDriveAction(state, NOW, { ...CONFIG, baseBackoffMs: 1_000 }).kind,
    ).toBe('complete');
  });

  it('chronic stall block-human bypasses exponential backoff', () => {
    const state = baseRunning({
      lastProgressAt: NOW - CONFIG.stallMs - 1,
      iteration: 8,
      lastActionAt: NOW - 50,
      stallSignalCount: CONFIG.chronicStallCount,
    });
    expect(
      decideDriveAction(state, NOW, { ...CONFIG, baseBackoffMs: 1_000 }).kind,
    ).toBe('block-human');
  });
});

describe('deriveDriveState', () => {
  const step = (partial: Partial<MissionMilestone> & { id: string; label: string }): MissionMilestone => ({
    status: 'pending',
    evidenceIds: [],
    ...partial,
  });

  const mission: DriveStateInputs['mission'] = {
    id: 'm1',
    status: 'running',
    updatedAt: 1_000,
    createdAt: 500,
    milestones: [step({ id: 's1', label: 'Design' })],
  };

  it('usa mission.updatedAt como lastProgressAt quando não há handoffs', () => {
    const state = deriveDriveState({ mission, handoffs: [] });
    expect(state.lastProgressAt).toBe(1_000);
    expect(state.lastStallSignalAt).toBeUndefined();
    expect(state.missionStatus).toBe('running');
    expect(state.missionId).toBe('m1');
    expect(state.steps).toHaveLength(1);
    expect(state.currentStepId).toBe('s1');
    expect(state.trustedEvidenceReadyForCurrent).toBe(false);
    expect(state.allStepsDone).toBe(false);
    expect(state.startedAt).toBe(500);
  });

  it('eleva lastProgressAt ao handoff não-stalled mais recente se maior que updatedAt', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'success',
          createdAt: 500,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
        {
          status: 'partial',
          createdAt: 5_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastProgressAt).toBe(5_000);
  });

  it('conta blocked/failed como progresso (são atividade, não silêncio)', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'blocked',
          createdAt: 4_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
        {
          status: 'failed',
          createdAt: 6_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastProgressAt).toBe(6_000);
  });

  it('não abaixa lastProgressAt abaixo de updatedAt (máximo vence)', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'success',
          createdAt: 200,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastProgressAt).toBe(1_000);
  });

  it('exclui handoffs stalled do cálculo de progresso', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'stalled',
          createdAt: 9_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastProgressAt).toBe(1_000);
  });

  it('lastStallSignalAt = handoff stalled mais recente, ignorando não-stalled no progresso', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'stalled',
          createdAt: 3_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
        {
          status: 'stalled',
          createdAt: 8_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
        {
          status: 'success',
          createdAt: 5_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastStallSignalAt).toBe(8_000);
    expect(state.lastProgressAt).toBe(5_000);
    expect(state.stallSignalCount).toBe(2);
  });

  it('lastStallSignalAt indefinido quando não há handoff stalled', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [
        {
          status: 'success',
          createdAt: 5_000,
          evidenceTrust: 'unverified',
          evidenceIds: [],
        },
      ],
    });
    expect(state.lastStallSignalAt).toBeUndefined();
  });

  it('marca trustedEvidenceReadyForCurrent quando evidenceIds são nexus-trusted', () => {
    const withEvidence: DriveStateInputs['mission'] = {
      ...mission,
      milestones: [
        step({
          id: 's1',
          label: 'Design',
          status: 'in-progress',
          evidenceIds: ['ev-trusted'],
        }),
      ],
    };
    const state = deriveDriveState({
      mission: withEvidence,
      handoffs: [
        {
          status: 'success',
          createdAt: 2_000,
          evidenceTrust: 'nexus-trusted',
          evidenceIds: ['ev-trusted'],
        },
      ],
    });
    expect(state.trustedEvidenceReadyForCurrent).toBe(true);
    expect(state.steps[0]?.trustedEvidenceReady).toBe(true);
    expect(state.currentStepId).toBe('s1');
  });

  it('binds mission-level nexus-trusted evidence onto current step with empty evidenceIds', () => {
    // Production path: step starts without evidenceIds; trusted handoff exists.
    // Advance must be reachable without a prior store write attaching ids.
    const state = deriveDriveState({
      mission: {
        ...mission,
        milestones: [
          step({
            id: 's1',
            label: 'Design',
            status: 'in-progress',
            evidenceIds: [],
          }),
        ],
      },
      handoffs: [
        {
          status: 'success',
          createdAt: 2_000,
          evidenceTrust: 'nexus-trusted',
          evidenceIds: ['ev-from-handoff'],
        },
      ],
    });
    expect(state.steps[0]?.evidenceIds).toEqual(['ev-from-handoff']);
    expect(state.trustedEvidenceReadyForCurrent).toBe(true);
    expect(
      decideDriveAction(
        {
          ...state,
          lastProgressAt: NOW - 1_000,
          startedAt: NOW - 60_000,
          iteration: 0,
          contextRot: false,
          paneDead: false,
          accountFailed: false,
        },
        NOW,
        CONFIG,
      ).kind,
    ).toBe('advance');
  });

  it('does not reuse nexus-trusted evidence already claimed by a done step', () => {
    const state = deriveDriveState({
      mission: {
        ...mission,
        milestones: [
          step({
            id: 's1',
            label: 'Done step',
            status: 'done',
            evidenceIds: ['ev-shared'],
          }),
          step({
            id: 's2',
            label: 'Next',
            status: 'in-progress',
            evidenceIds: [],
          }),
        ],
      },
      handoffs: [
        {
          status: 'success',
          createdAt: 2_000,
          evidenceTrust: 'nexus-trusted',
          evidenceIds: ['ev-shared'],
        },
      ],
    });
    expect(state.currentStepId).toBe('s2');
    expect(state.steps[1]?.evidenceIds).toEqual([]);
    expect(state.trustedEvidenceReadyForCurrent).toBe(false);
  });

  it('allStepsDone quando todos os steps estão done', () => {
    const state = deriveDriveState({
      mission: {
        ...mission,
        milestones: [
          step({
            id: 's1',
            label: 'A',
            status: 'done',
            evidenceIds: ['e1'],
          }),
          step({
            id: 's2',
            label: 'B',
            status: 'done',
            evidenceIds: ['e2'],
          }),
        ],
      },
      handoffs: [],
    });
    expect(state.allStepsDone).toBe(true);
    expect(state.currentStepId).toBeUndefined();
  });

  it('propaga sinais de recovery (paneDead, contextRot, accountFailed, iteration)', () => {
    const state = deriveDriveState({
      mission,
      handoffs: [],
      signals: {
        paneDead: true,
        contextRot: true,
        accountFailed: true,
        iteration: 7,
        startedAt: 100,
        stallSignalCount: 3,
      },
    });
    expect(state.paneDead).toBe(true);
    expect(state.contextRot).toBe(true);
    expect(state.accountFailed).toBe(true);
    expect(state.iteration).toBe(7);
    expect(state.startedAt).toBe(100);
    expect(state.stallSignalCount).toBe(3);
  });
});

describe('driveBackoffMs', () => {
  it('cresce exponencialmente e satura em 5 min', () => {
    expect(driveBackoffMs(0, 1_000)).toBe(1_000);
    expect(driveBackoffMs(1, 1_000)).toBe(2_000);
    expect(driveBackoffMs(2, 1_000)).toBe(4_000);
    expect(driveBackoffMs(20, 1_000)).toBe(5 * 60_000);
  });
});
