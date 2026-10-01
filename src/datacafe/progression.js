/** Junta combo, missões e turno num só estado, para a cena chamar duas funções:
 * `scoreTicket` quando um ticket fecha e `progressionStep` a cada passo do relógio.
 * Puro e imutável. */
import { createCombo, comboHit, comboStep, comboMultiplier } from './combo.js';
import { MISSIONS, createMissions, missionEvent } from './missions.js';
import { createShift, shiftStep, shiftScore } from './shift.js';
import { completeTicket, levelFor } from './tickets.js';

export function createProgression(pool = MISSIONS, unavailable = []) {
  return { combo: createCombo(), missions: createMissions(pool, undefined, unavailable), shift: createShift() };
}

/** Um ticket concluído: combo, XP multiplicado, missões fechadas e pontos do turno. */
export function scoreTicket(state, progress, ticket, pool = MISSIONS, unavailable = []) {
  // Café é manutenção: não entra na sequência nem a quebra.
  const counts = ticket.kind !== 'coffee';
  const combo = counts ? comboHit(state.combo) : state.combo;
  const multiplier = counts ? comboMultiplier(combo) : 1;
  const result = completeTicket(progress, ticket, multiplier);
  let step = missionEvent(state.missions, { kind: ticket.kind }, pool, unavailable);
  const finished = [...step.finished];
  if (counts) {
    step = missionEvent(step.state, { kind: 'combo', value: combo.streak }, pool, unavailable);
    finished.push(...step.finished);
  }
  const bonus = finished.reduce((sum, mission) => sum + mission.xp, 0);
  const xp = result.progress.xp + bonus;
  const level = levelFor(xp);
  return {
    state: { combo, missions: step.state, shift: shiftScore(state.shift, result.xpGained + bonus) },
    progress: {
      ...result.progress, xp, level,
      bestCombo: Math.max(progress.bestCombo ?? 0, combo.streak),
      missions: (progress.missions ?? 0) + finished.length,
    },
    xpGained: result.xpGained,
    bonus,
    multiplier,
    leveledUp: level > progress.level,
    finished,
  };
}

export function progressionStep(state, dt) {
  const combo = comboStep(state.combo, dt);
  const shift = shiftStep(state.shift, dt);
  if (combo === state.combo && shift === state.shift) return { state, comboLost: false, shiftOver: false };
  return {
    state: { ...state, combo, shift },
    comboLost: state.combo.streak > 1 && combo.streak === 0,
    shiftOver: shift.over && !state.shift.over,
  };
}

/** Fecha o turno encerrado, guarda o recorde e começa outro. */
export function closeShift(state, progress) {
  const score = state.shift.score;
  const record = score > (progress.bestShift ?? 0);
  return {
    state: { ...state, shift: createShift() },
    progress: record ? { ...progress, bestShift: score } : progress,
    score,
    record,
  };
}
