/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHumanSilhouette,
  cohesionForStatus,
  cursorForce,
  figureMotionForStatus,
  gazeOffset,
  idleCohesion,
  JarvisParticleFigure,
  mulberry32,
  parallaxOffset,
  speakingEnergy,
  speakingZoneWeight,
} from './JarvisParticleFigure';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('mulberry32', () => {
  it('é determinístico e devolve valores em [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i += 1) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });
});

describe('buildHumanSilhueta', () => {
  it('gera o número pedido de pontos, todos dentro do quadrado unitário', () => {
    const pts = buildHumanSilhouette(200);
    expect(pts).toHaveLength(200);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('é determinístico para a mesma semente', () => {
    expect(buildHumanSilhouette(120, 7)).toEqual(buildHumanSilhouette(120, 7));
  });

  it('desenha um humano de pé: cabeça no topo, pés embaixo, altura > largura', () => {
    const pts = buildHumanSilhouette(400);
    const headCount = Math.round(400 * 0.14);
    const headTop = Math.min(...pts.slice(0, headCount).map((p) => p.y));
    const feet = Math.max(...pts.map((p) => p.y));
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    expect(headTop).toBeLessThan(0.2);
    expect(feet).toBeGreaterThan(0.9);
    expect(maxX - minX).toBeLessThan(feet - headTop);
  });

  it('zero ou negativo devolve vazio', () => {
    expect(buildHumanSilhouette(0)).toEqual([]);
    expect(buildHumanSilhouette(-5)).toEqual([]);
  });
});

describe('cohesionForStatus', () => {
  it('forma o corpo inteiro ao ouvir/falar e dissolve em repouso', () => {
    expect(cohesionForStatus('listening')).toBe(1);
    expect(cohesionForStatus('speaking')).toBe(1);
    expect(cohesionForStatus('idle')).toBe(0);
  });

  it('mantém o erro parcialmente formado (nunca 1, nunca 0)', () => {
    const err = cohesionForStatus('error');
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(1);
  });
});

describe('figureMotionForStatus', () => {
  it('cada fase tem assinatura própria de movimento', () => {
    const listening = figureMotionForStatus('listening');
    expect(listening.cohesion).toBe(1);
    expect(listening.inward).toBeGreaterThan(0); // puxada para dentro
    expect(listening.breathe).toBeGreaterThan(0); // pulsa com o nível

    const speaking = figureMotionForStatus('speaking');
    expect(speaking.ripple).toBeGreaterThan(0); // ondas da cabeça/peito
    expect(speaking.jitter).toBeGreaterThan(0); // boca/torso vibrando

    const routing = figureMotionForStatus('routing');
    expect(routing.orbit).toBeGreaterThan(0); // vórtice/órbita
    expect(routing.cohesion).toBeLessThan(1);

    const transcribing = figureMotionForStatus('transcribing');
    expect(transcribing.orbit).toBeGreaterThan(0);
    expect(transcribing.orbit).toBeLessThan(routing.orbit);

    const idle = figureMotionForStatus('idle');
    expect(idle.breathe).toBeGreaterThan(0); // respiração suave
    expect(idle.cohesion).toBe(0); // forma se desfaz

    const error = figureMotionForStatus('error');
    expect(error.wander).toBeGreaterThan(idle.wander); // dispersão
    expect(error.jitter).toBeGreaterThan(0);
  });
});

describe('idleCohesion', () => {
  it('oscila devagar entre quase-dissolvido e meio-formado, sempre > 0', () => {
    for (let i = 0; i <= 200; i += 1) {
      const v = idleCohesion(i * 0.1);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(0.35);
    }
  });

  it('é periódico: desfaz e refaz a forma', () => {
    const period = (Math.PI * 2) / 0.55;
    expect(idleCohesion(3)).toBeCloseTo(idleCohesion(3 + period), 10);
    expect(idleCohesion(1)).not.toBe(idleCohesion(1 + period / 2));
  });
});

describe('speakingEnergy', () => {
  it('usa o nível real de áudio quando existe', () => {
    expect(speakingEnergy(0.5, 1)).toBe(0.5);
    expect(speakingEnergy(1, 1)).toBe(1);
  });

  it('sem nível, mantém um pulso base (nunca negativo, nunca parado em 0)', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = speakingEnergy(0, i * 0.13);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(0.6);
    }
  });
});

describe('speakingZoneWeight', () => {
  it('pesa o torso/peito mais que a cabeça, pernas quase nada', () => {
    expect(speakingZoneWeight(0.4)).toBe(1); // peito
    expect(speakingZoneWeight(0.15)).toBe(0.55); // cabeça/boca
    expect(speakingZoneWeight(0.8)).toBeLessThan(0.4); // pernas
  });
});

describe('cursorForce', () => {
  it('empurra para longe do cursor, mais perto do ponteiro', () => {
    const near = cursorForce(54, 50, 52, 50, 40, 1);
    const far = cursorForce(80, 50, 52, 50, 40, 1);
    expect(near.x).toBeGreaterThan(0);
    expect(near.x).toBeGreaterThan(far.x);
    expect(near.y).toBe(0);
    // Direção radial: partícula acima do cursor, força para cima (y negativo).
    expect(cursorForce(50, 50, 50, 55, 40, 1).y).toBeLessThan(0);
  });

  it('zero fora do raio, com strength 0, no próprio cursor ou raio inválido', () => {
    expect(cursorForce(0, 0, 100, 0, 40, 1)).toEqual({ x: 0, y: 0 });
    expect(cursorForce(50, 50, 52, 50, 40, 0)).toEqual({ x: 0, y: 0 });
    expect(cursorForce(50, 50, 50, 50, 40, 1)).toEqual({ x: 0, y: 0 });
    expect(cursorForce(50, 50, 52, 50, 0, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe('gazeOffset', () => {
  it('aponta na direção do cursor e trava no máximo', () => {
    const head = { x: 70, y: 20 };
    const g = gazeOffset(head.x, head.y, 200, 40, 8);
    expect(g.x).toBeGreaterThan(0);
    expect(Math.hypot(g.x, g.y)).toBeLessThanOrEqual(8 + 1e-9);
    // Cursor longe: deslocamento no teto (maxPx).
    const far = gazeOffset(head.x, head.y, 500, 20, 8);
    expect(far.x).toBeCloseTo(8, 5);
    expect(far.y).toBeCloseTo(0, 5);
  });

  it('cursor sobre a cabeça ou maxPx zero = sem deslocamento', () => {
    expect(gazeOffset(70, 20, 70, 20, 8)).toEqual({ x: 0, y: 0 });
    expect(gazeOffset(70, 20, 200, 40, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('parallaxOffset', () => {
  it('desloca na direção do cursor, escalando com a profundidade', () => {
    const base = parallaxOffset(90, 60, 50, 50, 100, 10, 1);
    expect(base.x).toBeGreaterThan(0);
    expect(base.y).toBeGreaterThan(0);
    const feet = parallaxOffset(90, 60, 50, 50, 100, 10, 0.3);
    expect(feet.x).toBeCloseTo(base.x * 0.3, 6);
  });

  it('cursor no centro = zero; fora do canvas trava em ±maxPx', () => {
    expect(parallaxOffset(50, 50, 50, 50, 100, 10, 1)).toEqual({ x: 0, y: 0 });
    const edge = parallaxOffset(999, 50, 50, 50, 100, 10, 1);
    expect(edge.x).toBeCloseTo(10, 6);
  });
});

describe('JarvisParticleFigure', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('renderiza um canvas decorativo que nunca rouba clique/arraste', () => {
    act(() => {
      root.render(<JarvisParticleFigure status="idle" />);
    });
    const canvas = host.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.className).toContain('jarvis-particle-figure');
  });
});
