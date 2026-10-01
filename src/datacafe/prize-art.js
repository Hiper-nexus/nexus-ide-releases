/** Desenho do painel de LED do sorteio e das faces da ficha, em canvas 2D.
 * Recebe o modelo de quadro de billboard.js (puro); nada aqui decide o que mostrar. */
import { PALETTE, hex } from './palette.js';
import { MODELS } from './models.js';
import { tickerPhrases, goalLine } from '../sorteio/prizes.js';

export const BOARD_SIZE = Object.freeze({ width: 1024, height: 277 });
export const COIN_SIZE = 128;

const FONT = 'VT323, ui-monospace, monospace';
const MONO = 'ui-monospace, monospace';
const brandOf = prize => MODELS.find(model => model.id === prize.id)?.color ?? PALETTE.pink;
const usable = image => Boolean(image?.complete && image.naturalWidth);

/** Trama de pontos de LED: um canvas pequeno repetido, criado uma vez por contexto. */
const dots = new WeakMap();
function dotPattern(context) {
  if (!dots.has(context)) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 4;
    const paint = tile.getContext('2d');
    paint.fillStyle = 'rgba(0,0,0,0.38)';
    paint.fillRect(0, 3, 4, 1);
    paint.fillRect(3, 0, 1, 4);
    dots.set(context, context.createPattern(tile, 'repeat'));
  }
  return dots.get(context);
}

function paintMark(context, cx, cy, radius, prize, image) {
  context.fillStyle = hex(brandOf(prize));
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = hex(PALETTE.ink);
  context.beginPath();
  context.arc(cx, cy, radius - 8, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = hex(PALETTE.ink);
  context.beginPath();
  context.arc(cx, cy, radius * 0.62, 0, Math.PI * 2);
  context.fill();
  if (usable(image)) {
    const size = radius * 0.78;
    context.drawImage(image, cx - size / 2, cy - size / 2, size, size);
  } else {
    context.fillStyle = hex(brandOf(prize));
    context.font = `700 ${Math.round(radius * 0.55)}px ${MONO}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(prize.brand.slice(0, 2).toUpperCase(), cx, cy);
  }
}

/** O conteúdo que muda de prêmio para prêmio: logo, título e meta. */
function paintSlot(context, w, prize, image, alpha, pulse) {
  context.globalAlpha = alpha;
  paintMark(context, 134, 124, 84, prize, image);
  const left = 262;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = hex(PALETTE.muted);
  context.font = `600 20px ${MONO}`;
  context.fillText(`SORTEIO NO GRUPO · ${prize.duration.toUpperCase()}`, left, 40);
  const head = `CONTA ${prize.brand.toUpperCase()}`;
  context.font = `400 118px ${FONT}`;
  context.shadowColor = hex(PALETTE.pink);
  context.shadowBlur = 10 + 26 * pulse;
  context.fillStyle = hex(PALETTE.ink);
  context.fillText(head, left, 142, w - left - 230);
  const headWidth = Math.min(context.measureText(head).width, w - left - 230);
  context.fillStyle = hex(PALETTE.pink);
  context.fillText(` ${prize.tier}`, left + headWidth, 142, 220);
  context.shadowBlur = 0;
  context.fillStyle = hex(PALETTE.pink);
  context.font = `400 46px ${FONT}`;
  context.fillText(goalLine(prize).toUpperCase(), left, 198);
  context.globalAlpha = 1;
}

function paintReel(context, w, reel) {
  context.textAlign = 'right';
  context.fillStyle = hex(PALETTE.muted);
  context.font = `600 15px ${MONO}`;
  context.fillText('GANHADOR', w - 34, 154);
  context.fillStyle = hex(PALETTE.ink);
  context.font = `400 46px ${FONT}`;
  context.fillText(reel, w - 34, 202);
}

function paintMarquee(context, w, top, h, offset) {
  context.fillStyle = '#0d0b10';
  context.fillRect(0, top, w, h - top);
  context.fillStyle = hex(PALETTE.pink);
  context.fillRect(0, top, w, 3);
  context.font = `600 22px ${MONO}`;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  const phrases = tickerPhrases();
  const gap = 56;
  const widths = phrases.map(phrase => context.measureText(phrase).width);
  const loop = widths.reduce((sum, width) => sum + width + gap, 0);
  const mid = top + (h - top) / 2 + 2;
  let x = -(offset % loop);
  for (let guard = 0; x < w && guard < 40; guard++) {
    phrases.forEach((phrase, i) => {
      context.fillStyle = i < 2 ? hex(PALETTE.ink) : hex(PALETTE.muted);
      context.fillText(phrase, x, mid);
      context.fillStyle = hex(PALETTE.pink);
      context.fillRect(x + widths[i] + gap / 2 - 4, mid - 4, 8, 8);
      x += widths[i] + gap;
    });
  }
  context.textBaseline = 'alphabetic';
}

/** `markOf(id)` devolve a imagem da marca (ou null enquanto baixa). */
export function paintBillboard(context, canvas, view, markOf) {
  const { width: w, height: h } = canvas;
  const sky = context.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#3a1236');
  sky.addColorStop(0.55, '#1c0c24');
  sky.addColorStop(1, '#0a060d');
  context.fillStyle = sky;
  context.fillRect(0, 0, w, h);
  const wash = context.createRadialGradient(w * 0.55, h * 0.45, 10, w * 0.55, h * 0.45, w * 0.5);
  wash.addColorStop(0, `rgba(255,111,145,${(0.34 * view.pulse).toFixed(3)})`);
  wash.addColorStop(1, 'rgba(255,111,145,0)');
  context.fillStyle = wash;
  context.fillRect(0, 0, w, h);
  paintSlot(context, w, view.prize, markOf(view.prize.id), 1 - view.blend, view.pulse);
  if (view.blend > 0) paintSlot(context, w, view.next, markOf(view.next.id), view.blend, view.pulse);
  paintReel(context, w, view.reel);
  paintMarquee(context, w, 226, h, view.marquee);
  context.fillStyle = dotPattern(context);
  context.fillRect(0, 0, w, h);
}

/** Uma face da ficha: disco na cor da marca, aro claro, marca ao centro e "20x" embaixo. */
export function paintCoinFace(context, canvas, prize, image) {
  const s = canvas.width, c = s / 2;
  context.clearRect(0, 0, s, s);
  context.fillStyle = hex(brandOf(prize));
  context.beginPath();
  context.arc(c, c, c - 2, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = hex(PALETTE.ink);
  context.lineWidth = 4;
  context.beginPath();
  context.arc(c, c, c - 10, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = hex(PALETTE.ink);
  context.beginPath();
  context.arc(c, c * 0.84, c * 0.5, 0, Math.PI * 2);
  context.fill();
  if (usable(image)) {
    const size = c * 0.66;
    context.drawImage(image, c - size / 2, c * 0.84 - size / 2, size, size);
  } else {
    context.fillStyle = hex(brandOf(prize));
    context.font = `700 ${Math.round(c * 0.4)}px ${MONO}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(prize.brand.slice(0, 2).toUpperCase(), c, c * 0.84);
  }
  context.fillStyle = hex(PALETTE.ink);
  context.font = `400 ${Math.round(s * 0.3)}px ${FONT}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(prize.tier, c, s * 0.82);
}
