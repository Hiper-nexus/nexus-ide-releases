import { describe, expect, it } from 'vitest';
import {
  nearestPerimeterT,
  nextRoamDelayMs,
  perimeterPoint,
  pickRoamDestination,
  roamStep,
  ROAM_IDLE_RECHECK_MS,
  ROAM_WALK_SPEED_PX_S,
} from './pet-roam';
import type { Rect, Size } from './pet-geometry';

const SIZE: Size = { width: 300, height: 340 };
const AREA: Rect = { x: 0, y: 25, width: 2560, height: 1055 };

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('perimeterPoint', () => {
  it('percorre as quatro bordas no sentido horário', () => {
    const top = perimeterPoint(0.02, AREA, SIZE);
    expect(top.y).toBe(AREA.y);
    expect(top.x).toBeGreaterThan(AREA.x);

    const right = perimeterPoint(0.45, AREA, SIZE);
    expect(right.x).toBe(AREA.x + AREA.width - SIZE.width);

    const bottom = perimeterPoint(0.62, AREA, SIZE);
    expect(bottom.y).toBe(AREA.y + AREA.height - SIZE.height);

    const left = perimeterPoint(0.92, AREA, SIZE);
    expect(left.x).toBe(AREA.x);
  });

  it('encosta nos cantos físicos da área', () => {
    expect(perimeterPoint(0, AREA, SIZE)).toEqual({ x: 0, y: 25 });
    const c = perimeterPoint(0.4999, AREA, SIZE);
    // fim da borda direita → encosta na parede direita
    expect(c.x).toBe(AREA.x + AREA.width - SIZE.width);
  });

  it('área degenerada devolve a origem sem NaN', () => {
    expect(perimeterPoint(0.5, { x: 5, y: 5, width: 0, height: 0 }, SIZE)).toEqual(
      { x: 5, y: 5 },
    );
  });
});

describe('nearestPerimeterT', () => {
  it('encontra a base quando o pet está nela', () => {
    const pos = { x: 1000, y: AREA.y + AREA.height - SIZE.height };
    const t = nearestPerimeterT(pos, AREA, SIZE);
    const p = perimeterPoint(t, AREA, SIZE);
    expect(Math.abs(p.y - pos.y)).toBeLessThanOrEqual(40);
  });
});

describe('pickRoamDestination', () => {
  it('rim-ahead continua o passeio a partir da posição atual', () => {
    const pos = { x: 0, y: AREA.y + AREA.height - SIZE.height };
    const rng = seqRng([0.1, 0.9, 0.5]); // roll<0.55 → rim-ahead, dir +, t offset
    const d = pickRoamDestination(pos, AREA, SIZE, rng);
    expect(d.kind).toBe('rim-ahead');
    expect(d.point.x).toBeGreaterThanOrEqual(AREA.x);
    expect(d.point.x).toBeLessThanOrEqual(AREA.x + AREA.width - SIZE.width);
    expect(d.point.y).toBeGreaterThanOrEqual(AREA.y);
    expect(d.point.y).toBeLessThanOrEqual(AREA.y + AREA.height - SIZE.height);
  });

  it('rim-any sorteia ponto do perímetro (sempre numa borda)', () => {
    const rng = seqRng([0.7, 0.42]);
    const d = pickRoamDestination(
      { x: 1000, y: 500 },
      AREA,
      SIZE,
      rng,
    );
    expect(d.kind).toBe('rim-any');
    const onEdge =
      d.point.x === AREA.x ||
      d.point.x === AREA.x + AREA.width - SIZE.width ||
      d.point.y === AREA.y ||
      d.point.y === AREA.y + AREA.height - SIZE.height;
    expect(onEdge).toBe(true);
  });

  it('interior sorteia ponto dentro da área', () => {
    const rng = seqRng([0.95, 0.5, 0.5]);
    const d = pickRoamDestination({ x: 0, y: 0 }, AREA, SIZE, rng);
    expect(d.kind).toBe('interior');
    expect(d.point.x).toBeGreaterThan(AREA.x);
    expect(d.point.x).toBeLessThan(AREA.x + AREA.width - SIZE.width);
    expect(d.point.y).toBeGreaterThan(AREA.y);
    expect(d.point.y).toBeLessThan(AREA.y + AREA.height - SIZE.height);
  });
});

describe('roamStep', () => {
  it('anda na direção do alvo com a velocidade pedida', () => {
    const r = roamStep({ x: 0, y: 0 }, { x: 1000, y: 0 }, 1000, 100);
    expect(r.next.x).toBe(100);
    expect(r.next.y).toBe(0);
    expect(r.arrived).toBe(false);
    expect(r.phase).toBe('walk');
    expect(r.dir).toBe('right');
    expect(r.climb).toBeNull();
  });

  it('marca chegada e encosta no alvo exato', () => {
    const r = roamStep({ x: 997, y: 0 }, { x: 1000, y: 0 }, 33, 120);
    expect(r.arrived).toBe(true);
    expect(r.next).toEqual({ x: 1000, y: 0 });
  });

  it('movimento vertical dominante vira climb', () => {
    const r = roamStep({ x: 0, y: 900 }, { x: 10, y: 0 }, 33, 120, 'left');
    expect(r.phase).toBe('climb');
    expect(r.climb).toBe('up');
    expect(r.dir).toBe('right'); // dx>0 ainda que pequeno
  });

  it('climb puro (dx≈0) mantém a face anterior', () => {
    const r = roamStep({ x: 500, y: 900 }, { x: 500, y: 0 }, 33, 120, 'left');
    expect(r.phase).toBe('climb');
    expect(r.dir).toBe('left');
  });

  it('walk para a esquerda reporta dir left', () => {
    const r = roamStep({ x: 900, y: 0 }, { x: 0, y: 0 }, 33, 120);
    expect(r.dir).toBe('left');
  });

  it('velocidade do contrato cobre um monitor em tempo de passeio', () => {
    // 2560px a 120px/s ≈ 21s — o "passeio" visível que o usuário pediu.
    const seconds = (AREA.width - SIZE.width) / ROAM_WALK_SPEED_PX_S;
    expect(seconds).toBeGreaterThan(10);
    expect(seconds).toBeLessThan(40);
  });
});

describe('nextRoamDelayMs', () => {
  const tickMs = 33;

  it('caminhando mantém o passo da animação', () => {
    expect(nextRoamDelayMs({ blocked: false, walking: true, now: 0, pauseUntil: 0, tickMs }))
      .toBe(tickMs);
  });

  it('bloqueada re-checa os vetos 1×/s em vez de a cada quadro', () => {
    expect(nextRoamDelayMs({ blocked: true, walking: false, now: 0, pauseUntil: 0, tickMs }))
      .toBe(ROAM_IDLE_RECHECK_MS);
    expect(ROAM_IDLE_RECHECK_MS).toBeGreaterThanOrEqual(10 * tickMs);
  });

  it('em pausa acorda no fim dela, no máximo a cada re-checagem', () => {
    expect(nextRoamDelayMs({ blocked: false, walking: false, now: 1_000, pauseUntil: 1_400, tickMs }))
      .toBe(400);
    expect(nextRoamDelayMs({ blocked: false, walking: false, now: 0, pauseUntil: 9_000, tickMs }))
      .toBe(ROAM_IDLE_RECHECK_MS);
  });

  it('pausa vencida sorteia o próximo destino no passo seguinte', () => {
    expect(nextRoamDelayMs({ blocked: false, walking: false, now: 5_000, pauseUntil: 4_000, tickMs }))
      .toBe(tickMs);
  });

  it('fim de pausa iminente nunca agenda abaixo do passo', () => {
    expect(nextRoamDelayMs({ blocked: false, walking: false, now: 1_000, pauseUntil: 1_010, tickMs }))
      .toBe(tickMs);
  });
});
