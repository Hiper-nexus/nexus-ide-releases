import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADAPTIVE_CAP,
  createAdaptiveCapState,
  decideAdaptiveCap,
  resolveAdaptiveLadderPolicy,
  type AdaptiveCapState,
} from './mission-scheduler';
import { productionAdaptiveCapSeed } from './mission-scheduler-production';

/**
 * A largada da escada é política de produto e pode mudar. O invariante do
 * teste é a RELAÇÃO (largada, largada+1 após rampa), não o número literal —
 * hard-codar 2 fazia subir o padrão reprovar uma escada correta.
 */
const START = DEFAULT_ADAPTIVE_CAP.currentCap;

const HARDWARE_CEILING = 8; // this machine: 10 cores -> cores-2

describe('resolveAdaptiveLadderPolicy — ceiling coherence (item 3)', () => {
  it('aligns the ladder ceiling with the hardware ceiling by default', () => {
    // maxCap=6 silently capped a machine that affords 8. Never cap the user
    // below what the host can actually run without saying so.
    const policy = resolveAdaptiveLadderPolicy({
      hardwareCeiling: HARDWARE_CEILING,
    });

    expect(policy.maxCap).toBe(8);
    expect(policy.startCap).toBe(START);
    expect(policy.rampAfterCleanWaves).toBe(2);
  });

  it('honours an explicit operator ceiling over the hardware one', () => {
    const policy = resolveAdaptiveLadderPolicy({
      maxCap: 4,
      hardwareCeiling: HARDWARE_CEILING,
    });

    expect(policy.maxCap).toBe(4);
  });

  it('lets the operator raise the starting cap for a big project', () => {
    const policy = resolveAdaptiveLadderPolicy({
      startCap: 6,
      hardwareCeiling: HARDWARE_CEILING,
    });

    expect(policy.startCap).toBe(6);
    expect(createAdaptiveCapState(policy).currentCap).toBe(6);
  });

  it('never lets the start exceed the ceiling', () => {
    const policy = resolveAdaptiveLadderPolicy({
      startCap: 32,
      maxCap: 5,
      hardwareCeiling: HARDWARE_CEILING,
    });

    expect(policy.startCap).toBe(5);
    expect(policy.maxCap).toBe(5);
  });

  it('clamps a nonsense hardware ceiling to a runnable wave', () => {
    const policy = resolveAdaptiveLadderPolicy({ hardwareCeiling: 0 });

    expect(policy.maxCap).toBeGreaterThanOrEqual(1);
    expect(policy.startCap).toBeGreaterThanOrEqual(1);
  });
});

describe('productionAdaptiveCapSeed — wiring (items 1 + 3)', () => {
  const contract = (maxWorkers: number) =>
    ({ budgets: { planningTokens: 0, executionTokens: 0, maxWorkers } }) as never;
  const limits = { cores: 10, paneBudget: 14 };

  it('seeds the ladder ceiling from the machine, not the old hardcoded 6', () => {
    const seed = productionAdaptiveCapSeed(contract(12), {}, limits);

    // 10 cores - 2 = 8, contract 12, panes 14 -> the host is the ceiling.
    expect(seed.maxCap).toBe(8);
    expect(seed.currentCap).toBe(4);
  });

  it('larga agressiva em produção, a menos que o operador sobrescreva', () => {
    // A biblioteca é conservadora de propósito (fail-safe); o PRODUTO tem
    // opinião. Se esta assertiva cair para o default da biblioteca, um host
    // de 8+ núcleos volta a rastejar em duas frentes sem ninguém perceber.
    const seed = productionAdaptiveCapSeed(contract(12), {}, limits);
    expect(seed.currentCap).toBe(4);
    expect(seed.currentCap).toBeGreaterThan(DEFAULT_ADAPTIVE_CAP.currentCap);
  });

  it('respeita a largada escolhida pelo operador acima do padrão de produção', () => {
    const seed = productionAdaptiveCapSeed(
      contract(12),
      { adaptiveWaveLadder: { startCap: 1, maxCap: null, rampAfterCleanWaves: null } },
      limits,
    );
    expect(seed.currentCap).toBe(1);
  });

  it('never promises a wave wider than the approved contract', () => {
    const seed = productionAdaptiveCapSeed(contract(3), {}, limits);

    expect(seed.maxCap).toBe(3);
  });

  it('lets the operator start wide on a big project without editing code', () => {
    const seed = productionAdaptiveCapSeed(
      contract(12),
      { adaptiveWaveLadder: { startCap: 8, maxCap: null, rampAfterCleanWaves: 1 } },
      limits,
    );

    expect(seed.currentCap).toBe(8);
    expect(seed.maxCap).toBe(8);
    expect(seed.rampAfterCleanWaves).toBe(1);
  });

  it('honours an explicit operator ceiling below the hardware one', () => {
    const seed = productionAdaptiveCapSeed(
      contract(12),
      { adaptiveWaveLadder: { maxCap: 4 } },
      limits,
    );

    expect(seed.maxCap).toBe(4);
  });

  it('stays runnable when no contract is available yet', () => {
    const seed = productionAdaptiveCapSeed(null, {}, limits);

    expect(seed.maxCap).toBe(8);
    expect(seed.currentCap).toBeGreaterThanOrEqual(1);
  });
});

describe('decideAdaptiveCap — ramp honesty (item 2)', () => {
  const ladder = (overrides: Partial<AdaptiveCapState> = {}): AdaptiveCapState => ({
    ...DEFAULT_ADAPTIVE_CAP,
    maxCap: HARDWARE_CEILING,
    ...overrides,
  });

  it('ramps promptly while workers complete without failures', () => {
    let state = ladder();
    expect(state.currentCap).toBe(START);
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 9 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 7 });
    expect(state.currentCap).toBe(START + 1);
  });

  it('climbs all the way to the ceiling instead of stalling below it', () => {
    let state = ladder();
    for (let wave = 0; wave < 40; wave += 1) {
      state = decideAdaptiveCap(state, {
        kind: 'wave',
        waveSize: state.currentCap,
        readyCount: 30,
      });
    }
    expect(state.currentCap).toBe(HARDWARE_CEILING);
  });

  it('does NOT reset the streak for a wave that was narrow because the PLAN was narrow', () => {
    // THE RAMP BUG: a legitimately serial phase (lone quality gate, last story)
    // produced waveSize 1 and wiped the streak, so a real mission that
    // interleaves serial phases never ramped at all. A wave that admitted
    // everything eligible is no evidence of conflict — it must be neutral.
    let state = ladder();
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 5 });
    expect(state.consecutiveCleanWaves).toBe(1);

    // Serial phase: 1 eligible unit, 1 admitted — nothing was refused.
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 1, readyCount: 1 });
    expect(state.consecutiveCleanWaves).toBe(1);
    expect(state.currentCap).toBe(START);

    // Parallel work returns and the ladder ramps instead of restarting.
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 5 });
    expect(state.currentCap).toBe(START + 1);
  });

  it('still resets when a narrow wave means work WAS refused', () => {
    // 5 eligible, cap 2, but only 1 admitted → ownership conflict blocked the
    // rest. That IS evidence of contention and must not widen the ladder.
    let state = ladder();
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 5 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 1, readyCount: 5 });
    expect(state.consecutiveCleanWaves).toBe(0);
    expect(state.currentCap).toBe(START);
  });

  it('shrinks immediately on conflict and violation, as before', () => {
    let state = decideAdaptiveCap(ladder({ currentCap: 5 }), { kind: 'conflict' });
    expect(state.currentCap).toBe(4);
    expect(state.consecutiveCleanWaves).toBe(0);
    state = decideAdaptiveCap(state, { kind: 'violation' });
    expect(state.currentCap).toBe(3);
  });

  it('never widens past the ladder ceiling', () => {
    let state = ladder({ currentCap: 8, maxCap: 8 });
    for (let wave = 0; wave < 10; wave += 1) {
      state = decideAdaptiveCap(state, {
        kind: 'wave',
        waveSize: 8,
        readyCount: 30,
      });
    }
    expect(state.currentCap).toBe(8);
  });

  it('respects a slower ramp when the operator asks for one', () => {
    let state = ladder({ rampAfterCleanWaves: 4 });
    for (let wave = 0; wave < 3; wave += 1) {
      state = decideAdaptiveCap(state, {
        kind: 'wave',
        waveSize: 2,
        readyCount: 9,
      });
    }
    expect(state.currentCap).toBe(START);
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2, readyCount: 9 });
    expect(state.currentCap).toBe(START + 1);
  });

  it('stays backward compatible when the caller omits readyCount', () => {
    let state = ladder();
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    expect(state.currentCap).toBe(START + 1);
  });
});
