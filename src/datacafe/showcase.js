/** Câmera de vitrine do Data Café: o passeio antes de começar, a espiada no painel do
 * sorteio ao começar e a hora de o farol apontar para o prêmio. Puro: o relógio e o mapa
 * entram por parâmetro; quem aplica na câmera é scene.js/rig.js. */
import { LAYOUT } from './layout.js';
import { RIG } from './rig.js';
import { nextPrize, goalLine } from '../sorteio/prizes.js';

const TAU = Math.PI * 2;
const TAN_HALF_FOV = Math.tan(RIG.fov * Math.PI / 360);

export const ATTRACT = Object.freeze({
  /** Centro e amplitude do passeio no chão; `reach` é o quanto a câmera pode se afastar do centro do painel. */
  x: 14, sweepX: 2.4, z: 4.2, sweepZ: 0.6, yaw: 0.3, zoom: 0.92, dolly: 0.1, reach: 3,
});

const idle = layout => ({ x: layout.width / 2, z: layout.height / 2 - 0.5 });

/** Para onde a câmera olha enquanto o jogo não começou. Sem movimento, o centro do salão, parado. */
export function attractPose(time, calm, out) {
  if (calm) {
    const center = idle(LAYOUT);
    out.x = center.x; out.z = center.z; out.yaw = 0; out.zoom = 1;
    return out;
  }
  out.x = ATTRACT.x + ATTRACT.sweepX * Math.sin((time / 41) * TAU);
  out.z = ATTRACT.z + ATTRACT.sweepZ * Math.sin((time / 29) * TAU + 1);
  out.yaw = ATTRACT.yaw * Math.sin((time / 53) * TAU);
  out.zoom = ATTRACT.zoom - ATTRACT.dolly * (0.5 + 0.5 * Math.sin((time / 23) * TAU));
  return out;
}

export const REVEAL = Object.freeze({ duration: 2.5, rise: 0.7, fall: 0.7 });

const smooth = value => value * value * (3 - 2 * value);

/** Peso (0 a 1) da espiada `t` segundos depois de começar: sobe, segura, desce. */
export function revealWeight(t, calm) {
  if (calm || t <= 0 || t >= REVEAL.duration) return 0;
  if (t < REVEAL.rise) return smooth(t / REVEAL.rise);
  if (t > REVEAL.duration - REVEAL.fall) return smooth((REVEAL.duration - t) / REVEAL.fall);
  return 1;
}

/** O ponto que a espiada mira: o meio do painel e da ficha acima dele. */
export function glanceTarget(layout) {
  return { x: layout.board.x + layout.board.width / 2, y: 1.7, z: layout.board.z + 0.2 };
}

/** Distância da câmera na espiada: a que faz o painel todo caber na largura do quadro. */
export function glanceRange(aspect) {
  return Math.max(5.5, Math.min(16, (LAYOUT.board.width * 1.18) / (2 * TAN_HALF_FOV * aspect)));
}

/** O farol do prêmio: em frente ao painel, em piso livre. */
export function prizeObjective(layout) {
  const prize = nextPrize();
  return {
    x: layout.board.x + layout.board.width / 2,
    z: layout.board.z + 1.45,
    kind: 'prize',
    text: `Veja o sorteio no painel: conta ${prize.brand} ${prize.tier} ${goalLine(prize)}`,
  };
}

/** Segundos parado antes de o farol cutucar quem ainda não viu o painel. */
export const IDLE_NUDGE = 40;

/** O farol aponta para o prêmio depois da primeira missão, ou depois de um tempo parado,
 * se ninguém abriu o painel ainda e não há tarefa urgente ou GPU na mão. */
export function shouldPointToPrize({ topKind, carrying, visited, finishedMissions, idleSeconds }) {
  if (carrying || visited) return false;
  if (topKind === 'incident' || topKind === 'coffee') return false;
  return finishedMissions >= 1 || idleSeconds >= IDLE_NUDGE;
}

/** Os pontos do caminho de seta no chão: do spawn, contornando as mesas do café, até o painel. */
export function prizePath(layout) {
  const row = layout.board.z + 1.5;
  return [
    { x: layout.spawn.x, z: layout.spawn.z - 0.25 },
    { x: layout.spawn.x + 0.7, z: row },
    { x: layout.board.x + layout.board.width / 2 - 0.6, z: row },
  ];
}

/** Setas a cada `spacing` ao longo da linha poligonal, a primeira meio passo adiante e nenhuma no fim.
 * `angle` é a rotação em torno de Y que leva +x para a direção do trecho. */
export function pathMarks(points, spacing) {
  const marks = [];
  let carry = spacing / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length === 0) continue;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
    const angle = -Math.atan2(uz, ux);
    let along = carry;
    while (along < length - 1e-9) {
      marks.push({ x: a.x + ux * along, z: a.z + uz * along, angle });
      along += spacing;
    }
    carry = along - length;
  }
  return marks;
}
