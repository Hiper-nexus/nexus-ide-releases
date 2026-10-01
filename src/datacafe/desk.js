/** A mesa do terminal: o dev senta, faz deploy segurando a ação e levanta.
 * Máquina de estados pura e imutável, como energy.js e racks.js:
 *
 *   standing → sitting → seated ⇄ acting → done → seated … → rising → standing
 *   (de pé)    (sentando) (sentado) (agindo) (concluído)      (levantando)
 *
 * Sentado: segurar a ação roda o deploy (soltar pausa), um toque rápido levanta, e andar
 * ou Esc levantam a qualquer momento. Cada passo devolve a mesa nova e empurra os
 * eventos ('seated', 'start', 'line', 'typing', 'deployed', 'failed', 'blocked',
 * 'abort', 'rise', 'standing') num array do chamador, para a cena tocar som e dar XP. */
import { angleDelta } from './walk.js';

export const DESK = {
  sitTime: 0.55,
  riseTime: 0.45,
  /** Abaixo disto o aperto é um toque (levanta); acima, começa a segurar. */
  tap: 0.22,
  runTime: 4.2,
  resultTime: 1.6,
  /** Depois de um deploy, o próximo build fica pronto em tantos segundos. */
  cooldown: 25,
  xp: 35,
  typeEvery: 0.11,
};

/** O que aparece no terminal e em que ponto do progresso. */
export const DEPLOY = Object.freeze([
  { at: 0, text: '$ nexus deploy --prod' },
  { at: 0.18, text: '› build ............ ok' },
  { at: 0.4, text: '› testes ............ ok' },
  { at: 0.62, text: '› canary ............ 5%' },
  { at: 0.84, text: '› rollout ......... 100%' },
]);
/** Linha em que um incidente aberto derruba o deploy. */
export const CANARY = 3;

const OPEN = Object.freeze({ blocked: null, fail: null });
const SEATED = new Set(['seated', 'acting', 'done']);
const ease = k => k * k * (3 - 2 * k);

export function createDesk() {
  return { phase: 'standing', t: 0, press: 0, armed: false, progress: 0, shown: 0, typed: 0, result: null, failure: null, cooldown: 0, deploys: 0 };
}

export function sit(desk) {
  return desk.phase === 'standing' ? { ...desk, phase: 'sitting', t: 0, press: 0, armed: false } : desk;
}

export function rise(desk) {
  return SEATED.has(desk.phase) || desk.phase === 'sitting' ? { ...desk, phase: 'rising', t: 0, press: 0, progress: desk.phase === 'acting' ? 0 : desk.progress } : desk;
}

/** Dá para fazer deploy agora? `blocked` impede de começar; `fail` derruba no canary. */
export function deployPlan({ cooldown = 0, powered = 0, incident = null }) {
  if (cooldown > 0) return { blocked: `Nada novo para publicar · próximo build em ${Math.ceil(cooldown)} s`, fail: null };
  if (powered === 0) return { blocked: 'Nenhum rack no ar para receber o deploy', fail: null };
  if (incident) return { blocked: null, fail: `canary falhou: ${incident} fora do ar` };
  return OPEN;
}

/**
 * Um passo da mesa. `input`: { dt, holding, moving, leave, plan, calm }.
 * Devolve a mesma mesa quando nada muda.
 */
export function deskStep(desk, { dt = 0, holding = false, moving = false, leave = false, plan = OPEN, calm = false } = {}, events = []) {
  const step = Math.max(0, Math.min(dt, 0.1));
  const cooldown = Math.max(0, desk.cooldown - step);

  if (desk.phase === 'standing') return cooldown === desk.cooldown ? desk : { ...desk, cooldown };
  if (desk.phase === 'sitting' || desk.phase === 'rising') {
    const t = desk.t + step;
    const sitting = desk.phase === 'sitting';
    if (calm || t >= (sitting ? DESK.sitTime : DESK.riseTime)) {
      events.push(sitting ? 'seated' : 'standing');
      return { ...desk, phase: sitting ? 'seated' : 'standing', t: 0, press: 0, armed: false, cooldown };
    }
    return { ...desk, t, cooldown };
  }

  // Sentado: andar ou Esc levantam em qualquer fase, abandonando um deploy em andamento.
  if (moving || leave) {
    if (desk.phase === 'acting') events.push('abort');
    events.push('rise');
    return { ...rise(desk), cooldown };
  }

  if (desk.phase === 'done') {
    const t = desk.t + step;
    if (t >= DESK.resultTime) return { ...desk, phase: 'seated', t: 0, press: 0, armed: !holding, cooldown };
    return { ...desk, t, cooldown };
  }

  if (desk.phase === 'acting') {
    if (!holding) return desk.press === 0 && cooldown === desk.cooldown ? desk : { ...desk, press: 0, cooldown };
    const progress = Math.min(1, desk.progress + step / DESK.runTime);
    let typed = desk.typed + step, shown = desk.shown;
    if (typed >= DESK.typeEvery) { typed -= DESK.typeEvery; events.push('typing'); }
    while (shown < DEPLOY.length && progress >= DEPLOY[shown].at) { shown++; events.push('line'); }
    if (plan.fail && shown > CANARY) {
      events.push('failed');
      return { ...desk, phase: 'done', t: 0, progress, shown, typed, press: 0, armed: false, result: 'failed', failure: plan.fail, cooldown };
    }
    if (progress >= 1) {
      events.push('deployed');
      return { ...desk, phase: 'done', t: 0, progress: 1, shown, typed, press: 0, armed: false, result: 'ok', failure: null, cooldown: DESK.cooldown, deploys: desk.deploys + 1 };
    }
    return { ...desk, progress, shown, typed, press: desk.press + step, cooldown };
  }

  // seated: um toque levanta; segurar começa o deploy. A tecla que sentou precisa ser solta antes.
  if (!holding) {
    if (desk.armed && desk.press > 0 && desk.press < DESK.tap) {
      events.push('rise');
      return { ...rise(desk), cooldown };
    }
    return desk.armed && desk.press === 0 && cooldown === desk.cooldown ? desk : { ...desk, armed: true, press: 0, cooldown };
  }
  if (!desk.armed) return cooldown === desk.cooldown ? desk : { ...desk, cooldown };
  const press = desk.press + step;
  if (press < DESK.tap) return { ...desk, press, cooldown };
  if (plan.blocked) {
    if (desk.press < DESK.tap) events.push('blocked');
    return { ...desk, press, cooldown };
  }
  events.push('start', 'line');
  return { ...desk, phase: 'acting', press, progress: 0, shown: 1, typed: 0, result: null, failure: null, cooldown };
}

/** 0 de pé, 1 sentado, com uma curva suave nas transições. */
export function seatBlend(desk) {
  if (desk.phase === 'sitting') return ease(Math.min(1, desk.t / DESK.sitTime));
  if (desk.phase === 'rising') return 1 - ease(Math.min(1, desk.t / DESK.riseTime));
  return SEATED.has(desk.phase) ? 1 : 0;
}

/** Onde o dev está: de `from` (onde começou a sentar) até o assento, olhando o monitor
 * (heading π, de costas para a câmera), e do assento até `stand` ao levantar. */
export function seatPose(desk, from, seat, stand, out = {}) {
  out.blend = seatBlend(desk);
  if (desk.phase === 'sitting') {
    const k = ease(Math.min(1, desk.t / DESK.sitTime));
    out.x = from.x + (seat.x - from.x) * k;
    out.z = from.z + (seat.z - from.z) * k;
    out.heading = from.heading + angleDelta(from.heading, Math.PI) * k;
  } else if (desk.phase === 'rising') {
    const k = ease(Math.min(1, desk.t / DESK.riseTime));
    out.x = seat.x + (stand.x - seat.x) * k;
    out.z = seat.z + (stand.z - seat.z) * k;
    out.heading = Math.PI;
  } else if (SEATED.has(desk.phase)) {
    out.x = seat.x; out.z = seat.z; out.heading = Math.PI;
  } else {
    out.x = from.x; out.z = from.z; out.heading = from.heading;
  }
  return out;
}
