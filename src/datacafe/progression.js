/** Junta combo, missões e turno num só estado, para a cena chamar duas funções:
 * `scoreTicket` quando um ticket fecha e `progressionStep` a cada passo do relógio.
 * Puro e imutável. */
import { createCombo, comboHit, comboStep, comboMultiplier } from './combo.js';
import { MISSIONS, createMissions, missionEvent } from './missions.js';
import { createShift, shiftStep, shiftScore } from './shift.js';
import { DRINK } from './energy-drink.js';
import { completeTicket, levelFor, titleFor, perkText, BADGES } from './tickets.js';

export function createProgression(pool = MISSIONS, unavailable = []) {
  return { combo: createCombo(), missions: createMissions(pool, undefined, unavailable), shift: createShift() };
}

/** Um ticket concluído: combo, XP multiplicado, missões fechadas e pontos do turno.
 * `turbo` (Nexus+) alarga a janela do combo e conta para a missão do turbo. */
export function scoreTicket(state, progress, ticket, pool = MISSIONS, unavailable = [], { turbo = false } = {}) {
  // Café é manutenção: não entra na sequência nem a quebra, nem vale para o turbo.
  const counts = ticket.kind !== 'coffee';
  const combo = counts ? comboHit(state.combo, turbo ? DRINK.comboScale : 1) : state.combo;
  const multiplier = counts ? comboMultiplier(combo) : 1;
  const result = completeTicket(progress, ticket, multiplier);
  const events = counts ? [{ kind: ticket.kind }, { kind: 'combo', value: combo.streak }] : [{ kind: ticket.kind }];
  if (counts && turbo) events.push({ kind: 'turbo' });
  const step = missionEvent(state.missions, events, pool, unavailable);
  const { finished } = step;
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

/** O aviso de uma premiação, numa linha só: o que fechou, o XP total que entrou (ticket,
 * combo e missões), a subida de nível e os selos novos. Um aviso único não é atropelado por outro. */
export function awardMessage(what, result, newBadges = []) {
  const parts = [];
  if (result.finished.length) parts.push(`${result.finished.length > 1 ? 'Missões cumpridas' : 'Missão cumprida'}: ${result.finished.map(mission => mission.text).join(' e ')}`);
  else parts.push(result.multiplier > 1 ? `${what} · combo ×${result.multiplier}` : what);
  parts.push(`+${result.xpGained + result.bonus} XP`);
  if (result.leveledUp) parts.push([`subiu para ${titleFor(result.progress.level)}`, perkText(result.progress.level)].filter(Boolean).join(', '));
  for (const badge of newBadges) parts.push(`selo: ${BADGES[badge]}`);
  return parts.join(' · ');
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
