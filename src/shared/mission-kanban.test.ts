import { describe, expect, it } from 'vitest';
import {
  missionLifecycleStateSchema,
  type MissionLifecycleState,
  type MissionSummarySnapshot,
} from './mission-engine-contract';
import {
  MISSION_KANBAN_LANES,
  MISSION_KANBAN_LANE_LABELS,
  missionKanbanLane,
  relativeAgeLabel,
  sortMissionsForLane,
  type MissionKanbanLane,
} from './mission-kanban';
import {
  RUNTIME_CLOSED_REASON_CODE,
  SESSION_DEAD_REASON_CODE,
  SESSION_SLEEPING_REASON_CODE,
} from './session-restore-liveness';

function summary(
  overrides: Partial<MissionSummarySnapshot> = {},
): MissionSummarySnapshot {
  return {
    id: 'mission-1',
    title: 'Missão de teste',
    state: 'running',
    progress: { completed: 0, total: 0 },
    needsAttention: false,
    updatedAt: 1_000,
    ...overrides,
  };
}

const QUIET = { awaitsOperatorReview: false } as const;

/**
 * Uma linha por estado do schema, no caso "quieto": sem atenção, sem razão
 * de isolamento, sem aceite pendente. O tipo `Record` obriga a tabela a
 * cobrir todo estado novo que entrar no contrato.
 */
const QUIET_LANE_BY_STATE: Readonly<
  Record<MissionLifecycleState, MissionKanbanLane>
> = {
  draft: 'building',
  review_ready: 'validating',
  starting: 'building',
  running: 'building',
  blocked_user: 'needs_you',
  blocked_technical: 'needs_you',
  recovering: 'building',
  stopping: 'building',
  failed: 'archive',
  completed: 'ready',
};

const LANE_IDS = MISSION_KANBAN_LANES.map((lane) => lane.id);

describe('missionKanbanLane — todo estado do schema cai em exatamente uma lane', () => {
  it('a tabela cobre exatamente os estados de missionLifecycleStateSchema', () => {
    expect(Object.keys(QUIET_LANE_BY_STATE).sort()).toEqual(
      [...missionLifecycleStateSchema.options].sort(),
    );
  });

  it.each(missionLifecycleStateSchema.options)(
    '%s (quieto) → lane única e conhecida',
    (state) => {
      const lane = missionKanbanLane(summary({ state }), QUIET);
      expect(lane).toBe(QUIET_LANE_BY_STATE[state]);
      expect(LANE_IDS.filter((id) => id === lane)).toHaveLength(1);
    },
  );

  it.each(missionLifecycleStateSchema.options)(
    '%s com needsAttention → Precisa de você, salvo terminal durável',
    (state) => {
      const lane = missionKanbanLane(
        summary({ state, needsAttention: true }),
        QUIET,
      );
      if (state === 'failed') {
        expect(lane).toBe('archive');
        return;
      }
      if (state === 'completed') {
        expect(lane).toBe('ready');
        return;
      }
      expect(lane).toBe('needs_you');
    },
  );
});

describe('missionKanbanLane — aceite humano', () => {
  it('concluída sem aceite fica em Validando; com aceite vai para Pronto', () => {
    expect(
      missionKanbanLane(summary({ state: 'completed' }), {
        awaitsOperatorReview: true,
      }),
    ).toBe('validating');
    expect(
      missionKanbanLane(summary({ state: 'completed' }), {
        awaitsOperatorReview: false,
      }),
    ).toBe('ready');
  });

  it('o aceite só importa para completed', () => {
    for (const state of missionLifecycleStateSchema.options) {
      if (state === 'completed') continue;
      expect(
        missionKanbanLane(summary({ state }), { awaitsOperatorReview: true }),
      ).toBe(missionKanbanLane(summary({ state }), QUIET));
    }
  });

  it('review_ready (plano pronto para iniciar) espera a sua validação', () => {
    expect(missionKanbanLane(summary({ state: 'review_ready' }), QUIET)).toBe(
      'validating',
    );
  });
});

describe('missionKanbanLane — Parou/Dormindo não é pedido humano', () => {
  const isolationCodes = [
    RUNTIME_CLOSED_REASON_CODE,
    SESSION_SLEEPING_REASON_CODE,
    SESSION_DEAD_REASON_CODE,
  ];
  const stoppedStates: MissionLifecycleState[] = [
    'blocked_user',
    'blocked_technical',
  ];

  it.each(
    stoppedStates.flatMap((state) =>
      isolationCodes.map((code) => [state, code] as const),
    ),
  )('%s + %s → Arquivo, mesmo que a atenção venha marcada', (state, code) => {
    const stopped = summary({
      state,
      stateReason: { code, label: 'Parou' },
    });
    expect(missionKanbanLane(stopped, QUIET)).toBe('archive');
    expect(
      missionKanbanLane({ ...stopped, needsAttention: true }, QUIET),
    ).toBe('archive');
  });

  it('razões que não são isolamento seguem o estado', () => {
    expect(
      missionKanbanLane(
        summary({
          state: 'blocked_user',
          stateReason: { code: 'open-question', label: 'Aguardando sua resposta' },
          needsAttention: true,
        }),
        QUIET,
      ),
    ).toBe('needs_you');
    expect(
      missionKanbanLane(
        summary({
          state: 'blocked_technical',
          stateReason: { code: 'restore-failed', label: 'Runtime não restaurado' },
          needsAttention: true,
        }),
        QUIET,
      ),
    ).toBe('needs_you');
    expect(
      missionKanbanLane(
        summary({
          state: 'blocked_technical',
          stateReason: { code: 'residual-work', label: 'Trabalho pendente' },
          needsAttention: true,
        }),
        QUIET,
      ),
    ).toBe('needs_you');
  });

  it('completed e failed ignoram a razão de isolamento (persist terminal é autoridade)', () => {
    const closed = { code: RUNTIME_CLOSED_REASON_CODE, label: 'Parou' };
    expect(
      missionKanbanLane(summary({ state: 'completed', stateReason: closed }), {
        awaitsOperatorReview: false,
      }),
    ).toBe('ready');
    expect(
      missionKanbanLane(summary({ state: 'failed', stateReason: closed }), QUIET),
    ).toBe('archive');
  });
});

describe('missionKanbanLane — arquivo do operador', () => {
  const ARCHIVED = { awaitsOperatorReview: false, archivedByOperator: true };

  it('nunca esconde trabalho vivo', () => {
    for (const state of ['starting', 'running', 'recovering', 'stopping'] as const) {
      expect(missionKanbanLane(summary({ state }), ARCHIVED)).toBe('building');
    }
  });

  it('nunca esconde um pedido aberto', () => {
    expect(
      missionKanbanLane(
        summary({ state: 'blocked_user', needsAttention: true }),
        ARCHIVED,
      ),
    ).toBe('needs_you');
    expect(
      missionKanbanLane(summary({ state: 'running', needsAttention: true }), ARCHIVED),
    ).toBe('needs_you');
  });

  it('esconde o que está parado: draft, plano pronto, concluída, falhada', () => {
    for (const state of ['draft', 'review_ready', 'completed', 'failed'] as const) {
      expect(missionKanbanLane(summary({ state }), ARCHIVED)).toBe('archive');
    }
    expect(
      missionKanbanLane(summary({ state: 'completed' }), {
        awaitsOperatorReview: true,
        archivedByOperator: true,
      }),
    ).toBe('archive');
  });
});

describe('MISSION_KANBAN_LANES', () => {
  it('lê da esquerda para a direita e termina no arquivo, único em gaveta', () => {
    expect(LANE_IDS).toEqual([
      'building',
      'validating',
      'needs_you',
      'ready',
      'archive',
    ]);
    const drawers = MISSION_KANBAN_LANES.filter(
      (lane) => lane.placement === 'drawer',
    );
    expect(drawers.map((lane) => lane.id)).toEqual(['archive']);
    expect(MISSION_KANBAN_LANES.at(-1)?.id).toBe('archive');
  });

  it('rótulos PT-BR em sentence case, iguais ao mapa de labels', () => {
    for (const lane of MISSION_KANBAN_LANES) {
      expect(lane.label).toBe(MISSION_KANBAN_LANE_LABELS[lane.id]);
      expect(lane.label).not.toBe(lane.label.toUpperCase());
      expect(lane.label.charAt(0)).toBe(lane.label.charAt(0).toUpperCase());
    }
    expect(MISSION_KANBAN_LANE_LABELS.needs_you).toBe('Precisa de você');
  });

  it('é imutável', () => {
    expect(Object.isFrozen(MISSION_KANBAN_LANES)).toBe(true);
  });
});

describe('sortMissionsForLane', () => {
  const items = [
    summary({ id: 'old-quiet', updatedAt: 10 }),
    summary({ id: 'new-quiet', updatedAt: 30 }),
    summary({ id: 'old-attention', updatedAt: 5, needsAttention: true }),
    summary({ id: 'new-attention', updatedAt: 20, needsAttention: true }),
  ];

  it('atenção primeiro, depois updatedAt decrescente', () => {
    const sorted = sortMissionsForLane(items, (item) => item);
    expect(sorted.map((item) => item.id)).toEqual([
      'new-attention',
      'old-attention',
      'new-quiet',
      'old-quiet',
    ]);
  });

  it('não muta a entrada e devolve um array novo', () => {
    const frozen = Object.freeze([...items]);
    const sorted = sortMissionsForLane(frozen, (item) => item);
    expect(sorted).not.toBe(frozen);
    expect(frozen.map((item) => item.id)).toEqual([
      'old-quiet',
      'new-quiet',
      'old-attention',
      'new-attention',
    ]);
  });

  it('empates preservam a ordem de entrada', () => {
    const ties = [
      summary({ id: 'a', updatedAt: 7 }),
      summary({ id: 'b', updatedAt: 7 }),
      summary({ id: 'c', updatedAt: 7 }),
    ];
    expect(
      sortMissionsForLane(ties, (item) => item).map((item) => item.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('aceita um seletor para envelopes que carregam o snapshot', () => {
    const wrapped = items.map((item) => ({ name: item.id, snapshot: item }));
    expect(
      sortMissionsForLane(wrapped, (item) => item.snapshot).map(
        (item) => item.name,
      ),
    ).toEqual(['new-attention', 'old-attention', 'new-quiet', 'old-quiet']);
  });
});

describe('relativeAgeLabel', () => {
  const NOW = 1_700_000_000_000;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [0, 'agora'],
    [59_999, 'agora'],
    [MINUTE, '1m'],
    [5 * MINUTE + 30_000, '5m'],
    [HOUR - 1, '59m'],
    [HOUR, '1h'],
    [2 * HOUR + 59 * MINUTE, '2h'],
    [DAY - 1, '23h'],
    [DAY, '1d'],
    [3 * DAY + 5 * HOUR, '3d'],
    [40 * DAY, '40d'],
  ])('há %d ms → %s', (elapsed, expected) => {
    expect(relativeAgeLabel(NOW - elapsed, NOW)).toBe(expected);
  });

  it('nunca mostra segundos', () => {
    for (const elapsed of [0, 1_000, 45_000, 90_000, 3_599_000, 86_399_000]) {
      expect(relativeAgeLabel(NOW - elapsed, NOW)).toMatch(/^(agora|\d+[mhd])$/);
    }
  });

  it('relógio adiantado ou valor inválido lê agora', () => {
    expect(relativeAgeLabel(NOW + HOUR, NOW)).toBe('agora');
    expect(relativeAgeLabel(Number.NaN, NOW)).toBe('agora');
    expect(relativeAgeLabel(NOW, Number.POSITIVE_INFINITY)).toBe('agora');
  });
});
