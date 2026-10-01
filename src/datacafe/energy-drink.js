/** O freezer do Nexus+ (marca fictícia, só do jogo): estoque, gelo e turbo.
 * Puro e imutável. O tempo entra como `now`, em segundos de jogo: quem chama
 * conta só o tempo em que o jogo corre, então pausar ou ocultar a aba congela
 * tudo (mesmo contrato do turno em shift.js e da mesa em desk.js). Tudo é guardado
 * como instante absoluto, por isso relógio que volta ou valor inválido nunca
 * corrompe o estado. */
export const DRINK = Object.freeze({
  stockMax: 12,
  stockStart: 8,
  /** Segundos para o freezer repor uma lata. */
  restockEvery: 15,
  /** Segundos de gelo entre uma lata e a seguinte. */
  cooldown: 30,
  /** Duração do turbo. */
  turbo: 20,
  /** Multiplicador de velocidade e da janela do combo enquanto dura o turbo. */
  speed: 1.4,
  comboScale: 1.5,
  /** O aviso de fim começa nos últimos segundos do turbo. */
  endingAt: 3,
});

/** Efeitos como constantes: pedir os efeitos a cada quadro nunca aloca. */
const ON = Object.freeze({ speed: DRINK.speed, comboScale: DRINK.comboScale });
export const NO_TURBO = Object.freeze({ speed: 1, comboScale: 1 });

const valid = now => typeof now === 'number' && Number.isFinite(now);

export function createDrinks(now = 0) {
  const start = valid(now) ? now : 0;
  return { stock: DRINK.stockStart, nextRestock: start + DRINK.restockEvery, readyAt: start, turboUntil: start, cans: 0 };
}

/** Repõe as latas que o tempo já trouxe. Devolve o mesmo estado quando nada mudou. */
export function drinkAdvance(state, now) {
  if (!valid(now) || state.stock >= DRINK.stockMax || now < state.nextRestock) return state;
  const due = Math.floor((now - state.nextRestock) / DRINK.restockEvery) + 1;
  const stock = Math.min(DRINK.stockMax, state.stock + due);
  // Cheio, o relógio de reposição para: só volta quando a primeira lata sair.
  const nextRestock = stock >= DRINK.stockMax ? Infinity : state.nextRestock + due * DRINK.restockEvery;
  return { ...state, stock, nextRestock };
}

/** Por que não dá para beber agora: 'ready', 'cooling' ou 'empty'. Vale para o estado já avançado até `now`. */
export function drinkReason(state, now) {
  if (!valid(now)) return 'cooling';
  if (state.stock <= 0) return 'empty';
  return now < state.readyAt ? 'cooling' : 'ready';
}

/** Segundos inteiros até o freezer permitir de novo (0 quando já dá). */
export function drinkWait(state, now) {
  if (!valid(now)) return 0;
  const reason = drinkReason(state, now);
  const until = reason === 'empty' ? state.nextRestock : reason === 'cooling' ? state.readyAt : now;
  const left = Math.ceil(until - now);
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** Tenta pegar uma lata. `{ ok, reason, waitSeconds, state }`: recusar nunca gasta lata nem muda o turbo. */
export function drinkCan(state, now) {
  const current = drinkAdvance(state, now);
  if (!valid(now)) return { ok: false, reason: 'cooling', waitSeconds: 0, state };
  const reason = drinkReason(current, now);
  if (reason !== 'ready') return { ok: false, reason, waitSeconds: drinkWait(current, now), state: current };
  const wasFull = current.stock >= DRINK.stockMax;
  return {
    ok: true,
    reason: null,
    waitSeconds: 0,
    state: {
      stock: current.stock - 1,
      nextRestock: wasFull ? now + DRINK.restockEvery : current.nextRestock,
      readyAt: now + DRINK.cooldown,
      turboUntil: now + DRINK.turbo,
      cans: current.cans + 1,
    },
  };
}

/** Segundos de turbo que restam, de 0 a 20. */
export function turboLeft(state, now) {
  if (!valid(now)) return 0;
  return Math.min(DRINK.turbo, Math.max(0, state.turboUntil - now));
}

/** Turbo de 1 a 0, para a barra do HUD. */
export function turboLevel(state, now) {
  return turboLeft(state, now) / DRINK.turbo;
}

/** Os últimos segundos do turbo: hora de um tique suave. */
export function turboEnding(state, now) {
  const left = turboLeft(state, now);
  return left > 0 && left <= DRINK.endingAt;
}

export function turboEffects(state, now) {
  return turboLeft(state, now) > 0 ? ON : NO_TURBO;
}
