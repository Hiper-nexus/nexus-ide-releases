/** Desenho, em canvas 2D, do freezer do Nexus+: letreiro de néon, plaqueta, rótulo da lata e a
 * porta de vidro. O Nexus+ é uma marca FICTÍCIA, só do jogo: a plaqueta diz isso em texto e
 * nenhum desenho promete nada além do nome. */
import { PALETTE, hex } from './palette.js';

export const SIGN_SIZE = Object.freeze({ width: 512, height: 128 });
export const PLAQUE_SIZE = Object.freeze({ width: 512, height: 64 });
export const CAN_SIZE = 64;
export const DOOR_SIZE = Object.freeze({ width: 128, height: 240 });

/** O aviso que também vai para o HUD e para o primeiro gole, em frase. */

const FONT = 'VT323, ui-monospace, monospace';
const MONO = 'ui-monospace, monospace';
const COLD = '#8fe9ff';

/** Letreiro de néon frio: o nome em ciano com brilho, e um filete rosa por baixo. */
export function paintSign(context, canvas) {
  const { width: w, height: h } = canvas;
  context.clearRect(0, 0, w, h);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `400 ${Math.round(h * 0.82)}px ${FONT}`;
  context.shadowColor = COLD;
  context.shadowBlur = h * 0.3;
  context.fillStyle = COLD;
  context.fillText('NEXUS+', w / 2, h * 0.47, w * 0.94);
  context.shadowBlur = 0;
  context.fillStyle = '#eafcff';
  context.fillText('NEXUS+', w / 2, h * 0.47, w * 0.94);
  context.fillStyle = hex(PALETTE.pink);
  context.fillRect(w * 0.12, h * 0.9, w * 0.76, h * 0.05);
}

/** Plaqueta baixa na frente do gabinete: a marca e o que ela é, um energético que dá energia. */
export function paintPlaque(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#17151b';
  context.fillRect(0, 0, w, h);
  context.fillStyle = '#2f2b36';
  context.fillRect(0, 0, w, 3);
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = COLD;
  context.font = `400 ${Math.round(h * 0.72)}px ${FONT}`;
  context.fillText('NEXUS+', 14, h * 0.54);
  context.textAlign = 'right';
  context.fillStyle = '#d9d2d8';
  context.font = `600 ${Math.round(h * 0.34)}px ${MONO}`;
  context.fillText('ENERGÉTICO · DÁ ENERGIA', w - 14, h * 0.54, w * 0.66);
}

/** Rótulo da lata, que dá a volta no cilindro: duas faixas brancas com o N+ (frente e costas). */
export function paintCan(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = hex(PALETTE.pink);
  context.fillRect(0, 0, w, h);
  context.fillStyle = '#c93a70';
  context.fillRect(0, 0, w, h * 0.12);
  context.fillRect(0, h * 0.88, w, h * 0.12);
  context.fillStyle = '#faf7f9';
  context.fillRect(0, h * 0.34, w, h * 0.32);
  context.fillStyle = '#19171d';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `400 ${Math.round(h * 0.34)}px ${FONT}`;
  for (const x of [0.25, 0.75]) context.fillText('N+', w * x, h * 0.52);
}

/** Porta de vidro: moldura de aço, puxador e dois reflexos. Sem texto. */
export function paintDoor(context, canvas) {
  const { width: w, height: h } = canvas;
  context.clearRect(0, 0, w, h);
  context.fillStyle = 'rgba(191,233,255,0.14)';
  context.fillRect(0, 0, w, h);
  context.fillStyle = 'rgba(255,255,255,0.16)';
  context.beginPath();
  context.moveTo(w * 0.12, h * 0.06); context.lineTo(w * 0.3, h * 0.06); context.lineTo(w * 0.06, h * 0.62); context.lineTo(w * 0.0, h * 0.62);
  context.fill();
  context.beginPath();
  context.moveTo(w * 0.38, h * 0.06); context.lineTo(w * 0.46, h * 0.06); context.lineTo(w * 0.2, h * 0.62); context.lineTo(w * 0.12, h * 0.62);
  context.fill();
  context.strokeStyle = '#3d3745';
  context.lineWidth = 9;
  context.strokeRect(4.5, 4.5, w - 9, h - 9);
  context.fillStyle = '#b9b2bd';
  context.fillRect(w * 0.82, h * 0.34, 7, h * 0.3);
}
