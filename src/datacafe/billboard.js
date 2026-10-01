/** O painel de LED do sorteio, como dados puros: o que ele mostra em cada instante.
 * O desenho no canvas e a geometria vivem em datacenter.js; aqui só há relógio,
 * então tudo é testável sem navegador. */
import { PRIZES } from '../sorteio/prizes.js';
import { DRAW, drawFrame } from '../sorteio/draw.js';

export const WINNER_PHRASE = 'PODE SER VOCÊ';

export const BILLBOARD = Object.freeze({
  /** Cada prêmio fica 6 s no painel; os últimos 0,6 s são a fusão com o seguinte. */
  slot: 6,
  fade: 0.6,
  /** Letreiro corrido: pixels do canvas por segundo. */
  marqueeSpeed: 70,
  pulsePeriod: 2.4,
  /** Voltas do anel de lâmpadas por segundo, e quantas luzes correm ao mesmo tempo. */
  chaseSpeed: 0.4,
  chaseHeads: 3,
  /** O canvas é redesenhado a 10 quadros por segundo: LED não precisa de mais. */
  repaint: 0.1,
});

const CALM = Object.freeze({
  prize: PRIZES[0], next: PRIZES[1], blend: 0, reel: WINNER_PHRASE, marquee: 0, chase: 0, pulse: 1,
});

const clamp01 = value => Math.max(0, Math.min(1, value));

/** O que o painel mostra em `time` (s). O acaso do letreiro vem de fora, para o teste escolher. */
export function billboardView(time, { calm = false, random = Math.random } = {}) {
  if (calm) return CALM;
  const t = Math.max(0, time);
  const slot = Math.floor(t / BILLBOARD.slot);
  const local = t - slot * BILLBOARD.slot;
  const cycle = DRAW.spin + DRAW.hold;
  const spinning = ((t * 1000) % cycle) / DRAW.spin;
  return {
    prize: PRIZES[slot % PRIZES.length],
    next: PRIZES[(slot + 1) % PRIZES.length],
    blend: clamp01((local - (BILLBOARD.slot - BILLBOARD.fade)) / BILLBOARD.fade),
    reel: drawFrame(WINNER_PHRASE, spinning, random),
    marquee: t * BILLBOARD.marqueeSpeed,
    chase: (t * BILLBOARD.chaseSpeed) % 1,
    pulse: Math.min(1, 0.81 + 0.19 * Math.sin((t / BILLBOARD.pulsePeriod) * Math.PI * 2)),
  };
}

/** Brilho (0,18 a 1) da lâmpada `index` de um anel de `count`, com a luz na posição `phase` (0 a 1).
 * A cauda fica atrás da cabeça, no sentido do anel; `heads` luzes igualmente espaçadas correm juntas. */
export function chaseLevel(index, count, phase, heads = 1) {
  const span = 0.3 / heads;
  let best = 0;
  for (let k = 0; k < heads; k++) {
    const head = (phase + k / heads) * count;
    let behind = (((head - index) % count) + count) % count;
    // Erro de ponto flutuante: uma cabeça "exatamente em cima" da lâmpada não pode contar a volta inteira.
    if (behind > count - 1e-6) behind = 0;
    best = Math.max(best, 1 - behind / count / span);
  }
  return Math.max(0.18, Math.min(1, best));
}

/** Posições (x, y) das lâmpadas na moldura, em volta do painel e a partir do canto de cima à esquerda,
 * no sentido horário. `spacing` é o passo desejado; o passo real fecha o anel sem emenda. */
export function bulbRing(width, height, spacing) {
  const perimeter = 2 * (width + height);
  const count = Math.round(perimeter / spacing);
  const halfW = width / 2, halfH = height / 2;
  const ring = [];
  for (let k = 0; k < count; k++) {
    let s = (k * perimeter) / count;
    if (s < width) ring.push({ x: -halfW + s, y: halfH });
    else if ((s -= width) < height) ring.push({ x: halfW, y: halfH - s });
    else if ((s -= height) < width) ring.push({ x: halfW - s, y: -halfH });
    else { s -= width; ring.push({ x: -halfW, y: -halfH + s }); }
  }
  return ring;
}
