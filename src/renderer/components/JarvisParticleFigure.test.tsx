/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceUiStatus } from '../voice/voice-store';
import { useVoiceStore } from '../voice/voice-store';
import {
  buildHumanSilhouette,
  breathingOffset,
  buildMouthRing,
  cohesionForStatus,
  cursorForce,
  figureLevel,
  figureMotionForStatus,
  gazeOffset,
  IDLE_COHESION_MID,
  IDLE_CYCLE_S,
  idleCohesion,
  idleParticleCohesion,
  idleScatter,
  JarvisParticleFigure,
  lipPoint,
  MOUTH_CENTER,
  MOUTH_CLOSED_HALF_HEIGHT,
  MOUTH_HALF_WIDTH,
  mouthDeform,
  mouthParticleCount,
  mouthShape,
  mulberry32,
  parallaxOffset,
  particleCountForSize,
  restPoint,
  smoothMouth,
  speakingEnergy,
  speakingZoneWeight,
  SYNTHETIC_MOUTH_GRACE_S,
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

  it('marca as pontas: cabeça e tronco são núcleo, mãos e pés são a ponta dos membros', () => {
    const n = 400;
    const pts = buildHumanSilhouette(n);
    const headNeckTorso = Math.round(n * 0.14) + Math.round(n * 0.04) + Math.round(n * 0.28);
    const arms = Math.round(n * 0.16);
    for (const p of pts.slice(0, headNeckTorso)) expect(p.tip).toBe(0);
    for (const p of pts) {
      expect(p.tip).toBeGreaterThanOrEqual(0);
      expect(p.tip).toBeLessThanOrEqual(1);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Perna: o pé (y baixo) é bem mais ponta que o quadril (y alto).
    const legs = pts.slice(headNeckTorso + arms);
    const feet = legs.filter((p) => p.y > 0.85);
    const hips = legs.filter((p) => p.y < 0.6);
    expect(mean(feet.map((p) => p.tip))).toBeGreaterThan(0.6);
    expect(mean(hips.map((p) => p.tip))).toBeLessThan(0.2);
    // Braço: a mão (y baixo) é mais ponta que o ombro (y alto).
    const armPts = pts.slice(headNeckTorso, headNeckTorso + arms);
    const hands = armPts.filter((p) => p.y > 0.48);
    const shoulders = armPts.filter((p) => p.y < 0.38);
    expect(mean(hands.map((p) => p.tip))).toBeGreaterThan(0.5);
    expect(mean(shoulders.map((p) => p.tip))).toBeLessThan(0.15);
    expect(Math.max(...legs.map((p) => p.tip))).toBeGreaterThan(0.9);
  });
});

describe('cohesionForStatus', () => {
  it('forma o corpo inteiro ao ouvir/falar e deixa o repouso reconhecível, porém mais poroso', () => {
    expect(cohesionForStatus('listening')).toBe(1);
    expect(cohesionForStatus('speaking')).toBe(1);
    const idle = cohesionForStatus('idle');
    expect(idle).toBe(IDLE_COHESION_MID);
    expect(idle).toBeGreaterThan(0.6); // a silhueta já lê como humano no repouso
    expect(idle).toBeLessThan(1); // e ainda é menos formada que ouvindo/falando
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
    expect(idle.cohesion).toBeGreaterThan(0.6); // reconhecível em repouso
    expect(idle.cohesion).toBeLessThan(1);

    const error = figureMotionForStatus('error');
    expect(error.wander).toBeGreaterThan(idle.wander); // dispersão
    expect(error.jitter).toBeGreaterThan(0);
  });

  it('só o ocioso dissolve LOCAL (pontas soltas); os demais estados vão à nuvem', () => {
    expect(figureMotionForStatus('idle').calm).toBe(1);
    const others: VoiceUiStatus[] = ['listening', 'transcribing', 'routing', 'speaking', 'error'];
    for (const status of others) expect(figureMotionForStatus(status).calm).toBe(0);
  });
});

describe('idleCohesion', () => {
  it('forma o corpo no pico, perde coesão no vale e nunca chega a inteiro nem some', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 2000; i += 1) {
      const v = idleCohesion(i * 0.01);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(max).toBeGreaterThanOrEqual(0.85); // pico alto: a figura se forma
    expect(max).toBeLessThan(1); // nunca vira o "corpo inteiro" do ouvir/falar
    expect(min).toBeGreaterThan(0.5); // o vale ainda é uma figura, só porosa
    expect(max - min).toBeGreaterThanOrEqual(0.2); // dissolução parcial perceptível
  });

  it('é periódico: desfaz e refaz a forma, com a coesão-base do estado no meio', () => {
    expect(idleCohesion(3)).toBeCloseTo(idleCohesion(3 + IDLE_CYCLE_S), 10);
    expect(idleCohesion(1)).not.toBeCloseTo(idleCohesion(1 + IDLE_CYCLE_S / 2), 3);
    expect(idleCohesion(0)).toBeCloseTo(IDLE_COHESION_MID, 10);
    expect(IDLE_CYCLE_S).toBeGreaterThan(6); // lento: respiração, não pisca
    expect(IDLE_CYCLE_S).toBeLessThan(14);
  });
});

describe('idleParticleCohesion', () => {
  const peak = IDLE_CYCLE_S / 4; // sin = 1: pico do núcleo
  const valley = (IDLE_CYCLE_S * 3) / 4; // sin = -1: vale do núcleo

  it('no vale as pontas soltam bem mais que o núcleo', () => {
    const core = idleParticleCohesion(valley, 0);
    const hand = idleParticleCohesion(valley, 0.6);
    const foot = idleParticleCohesion(valley, 1);
    expect(core).toBeGreaterThan(0.5); // o núcleo segue legível
    expect(hand).toBeLessThan(core);
    expect(foot).toBeLessThan(hand);
    expect(core - foot).toBeGreaterThan(0.25);
  });

  it('as pontas se refazem no pico: todas voltam perto da coesão cheia', () => {
    // A ponta atrasa ~0,6 s: olha o pico dela, não o do núcleo.
    const tipPeak = peak + 0.6;
    expect(idleParticleCohesion(peak, 0)).toBeGreaterThan(0.85);
    expect(idleParticleCohesion(tipPeak, 1)).toBeGreaterThan(0.85);
  });

  it('desfaz e refaz em ciclo, sempre dentro de [0,1]', () => {
    for (const tip of [0, 0.3, 0.7, 1]) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i <= 1800; i += 1) {
        const v = idleParticleCohesion(i * 0.01, tip);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(max - min).toBeGreaterThan(0.2); // há ciclo em todas as regiões
    }
  });

  it('o alcance da poeira cresce do núcleo para a ponta e fica fora da nuvem inteira', () => {
    expect(idleScatter(0)).toBeLessThan(idleScatter(1));
    expect(idleScatter(1)).toBeLessThan(0.5); // poeira local, nunca o canvas todo
    expect(idleScatter(-3)).toBe(idleScatter(0)); // tip fora de [0,1] é travado
    expect(idleScatter(9)).toBe(idleScatter(1));
  });
});

describe('restPoint', () => {
  const home = { x: 0.4, y: 0.6 };
  const cloud = { x: 0.9, y: 0.1 };

  it('coeso = a casa na silhueta; dissolvido = a nuvem', () => {
    expect(restPoint(home, cloud, 1)).toEqual(home);
    expect(restPoint(home, cloud, 0).x).toBeCloseTo(cloud.x, 12);
    expect(restPoint(home, cloud, 0).y).toBeCloseTo(cloud.y, 12);
  });

  it('com scatter 1 é a mesma interpolação casa↔nuvem de antes', () => {
    for (const form of [0.2, 0.5, 0.62, 0.9]) {
      const p = restPoint(home, cloud, form);
      expect(p.x).toBeCloseTo(cloud.x + (home.x - cloud.x) * form, 12);
      expect(p.y).toBeCloseTo(cloud.y + (home.y - cloud.y) * form, 12);
    }
  });

  it('scatter menor que 1 limita a dissolução a uma poeira perto da casa', () => {
    const dust = restPoint(home, cloud, 0, 0.2);
    expect(dust.x).toBeCloseTo(home.x + (cloud.x - home.x) * 0.2, 12);
    expect(Math.hypot(dust.x - home.x, dust.y - home.y)).toBeLessThan(
      Math.hypot(cloud.x - home.x, cloud.y - home.y) * 0.25,
    );
  });

  it('trava a coesão em [0,1]', () => {
    expect(restPoint(home, cloud, 3)).toEqual(home);
    expect(restPoint(home, cloud, -2).x).toBeCloseTo(cloud.x, 12);
  });
});

describe('breathingOffset', () => {
  const quarter = Math.PI / 2 / 1.5; // sin(1.5 t) = 1: inspira

  it('o peito sobe e a caixa torácica abre ao inspirar; as pernas ficam', () => {
    const chestRight = breathingOffset(0.62, 0.4, quarter);
    const chestLeft = breathingOffset(0.38, 0.4, quarter);
    expect(chestRight.y).toBeLessThan(0); // sobe (y cresce para baixo)
    expect(chestRight.x).toBeGreaterThan(0); // direita abre para a direita
    expect(chestLeft.x).toBeLessThan(0); // esquerda abre para a esquerda
    const feet = breathingOffset(0.5, 0.96, quarter);
    expect(Math.abs(feet.y)).toBeLessThan(Math.abs(chestRight.y) * 0.01);
  });

  it('expira na outra metade do ciclo e a cabeça acompanha menos que o peito', () => {
    const exhale = breathingOffset(0.62, 0.4, -quarter);
    expect(exhale.y).toBeGreaterThan(0);
    const head = breathingOffset(0.5, 0.155, quarter);
    expect(Math.abs(head.y)).toBeLessThan(Math.abs(breathingOffset(0.5, 0.4, quarter).y));
  });

  it('é suave e pequena: nunca passa de 1,5% do lado do canvas', () => {
    for (let i = 0; i < 200; i += 1) {
      const o = breathingOffset(0.65, 0.4, i * 0.1);
      expect(Math.abs(o.x)).toBeLessThan(0.015);
      expect(Math.abs(o.y)).toBeLessThan(0.015);
    }
  });
});

describe('particleCountForSize', () => {
  it('cresce com o canvas e respeita o piso e o teto', () => {
    expect(particleCountForSize(40)).toBe(120);
    expect(particleCountForSize(2000)).toBe(360);
    expect(particleCountForSize(180)).toBeGreaterThan(particleCountForSize(140));
    expect(particleCountForSize(140)).toBe(Math.round((140 * 140) / 85));
  });
});

describe('speakingEnergy', () => {
  it('usa o nível real de áudio quando existe', () => {
    expect(speakingEnergy(0.5, 1)).toBe(0.5);
    expect(speakingEnergy(1, 1)).toBe(1);
  });

  it('cresce monotonicamente com o nível real da voz', () => {
    const at = (level: number) => speakingEnergy(level, 4.2);
    expect(at(0.05)).toBeLessThan(at(0.3));
    expect(at(0.3)).toBeLessThan(at(0.6));
    expect(at(0.6)).toBeLessThan(at(0.95));
  });

  it('sem nível, mantém um pulso base (nunca negativo, nunca parado em 0)', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = speakingEnergy(0, i * 0.13);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(0.6);
    }
  });

  it('com voz já medida no turno, o silêncio é pausa: energia segue o nível, sem pulso', () => {
    expect(speakingEnergy(0, 1.3, true)).toBe(0);
    expect(speakingEnergy(0.01, 2.1, true)).toBe(0.01);
  });
});

describe('figureLevel', () => {
  it('falando usa o nível da própria voz (saída); ouvindo usa o microfone', () => {
    expect(figureLevel('speaking', 0.9, 0.2)).toBe(0.2);
    expect(figureLevel('listening', 0.9, 0.2)).toBe(0.9);
  });

  it('os demais estados ficam em silêncio (só o movimento base do estado)', () => {
    for (const status of ['idle', 'transcribing', 'routing', 'error'] as VoiceUiStatus[]) {
      expect(figureLevel(status, 0.9, 0.8)).toBe(0);
    }
  });

  it('trava em [0,1]', () => {
    expect(figureLevel('speaking', 0, 1.7)).toBe(1);
    expect(figureLevel('listening', -3, 0)).toBe(0);
  });
});

describe('speakingZoneWeight', () => {
  it('o torso ressoa, pernas quase nada e a cabeça quase parada (quem fala é a boca)', () => {
    expect(speakingZoneWeight(0.4)).toBe(1); // peito
    expect(speakingZoneWeight(0.15)).toBeLessThan(0.2); // cabeça: tremer borrava os lábios
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

  it('o CSS mantém o canvas pointer-events:none e o tamanho vem do container, não do viewport', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/jarvis-particles.css'), 'utf-8');
    const rule = /\.jarvis-particle-figure\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/pointer-events:\s*none/u);
    expect(rule).toMatch(/width:\s*100%/u);
    expect(rule).toMatch(/aspect-ratio:\s*1\b/u);
    expect(rule).not.toMatch(/\bvw\b|clamp\(/u);

    const hud = fs.readFileSync(path.join(__dirname, '../styles/voice-hud.css'), 'utf-8');
    const figure = /\n\.voice-figure\s*\{([^}]*)\}/u.exec(hud)?.[1] ?? '';
    expect(figure).toMatch(/aspect-ratio:\s*1\b/u);
    // A linha de chão assenta nos pés da silhueta (y = 0,96 do quadrado do canvas).
    const ground = /\n\.voice-figure__ground\s*\{([^}]*)\}/u.exec(hud)?.[1] ?? '';
    expect(ground).toMatch(/top:\s*97%/u);
    expect(ground).not.toMatch(/bottom:/u);
  });
});

// ---- canvas simulado: o loop e o quadro estático rodam de verdade -----------

interface DrawnArc {
  x: number;
  y: number;
  r: number;
  alpha: number;
  fill: string;
  kind: 'fill' | 'stroke' | 'pending';
}

const FRAME_MS = 1000 / 60;

/**
 * Monta o componente num canvas 2D simulado que grava o que é pintado. O
 * relógio (rAF + performance.now) é manual e o ResizeObserver é disparado à
 * mão: o teste conduz o tempo e o tamanho do canvas.
 */
function mountFigure(
  initial: VoiceUiStatus,
  options: { reduced?: boolean; size?: number } = {},
) {
  let size = options.size ?? 180;
  let clock = 0;
  let rafId = 0;
  let rafCalls = 0;
  const rafQueue = new Map<number, FrameRequestCallback>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  const frames: DrawnArc[][] = [];
  let current: DrawnArc[] = [];

  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 1,
    setTransform: vi.fn(),
    clearRect: vi.fn(() => {
      current = [];
      frames.push(current);
    }),
    beginPath: vi.fn(),
    arc: vi.fn((x: number, y: number, r: number) => {
      current.push({
        x,
        y,
        r,
        alpha: ctx.globalAlpha,
        fill: String(ctx.fillStyle),
        kind: 'pending',
      });
    }),
    fill: vi.fn(() => {
      const last = current.at(-1);
      if (last) last.kind = 'fill';
    }),
    stroke: vi.fn(() => {
      const last = current.at(-1);
      if (last) last.kind = 'stroke';
    }),
  };

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: Boolean(options.reduced),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCalls += 1;
    rafQueue.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => size,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    // Spec do canvas: mudar width/height zera o estado do contexto, composição
    // inclusa. Sem emular isso o teste não pega o resize que apaga o brilho.
    let width = 300;
    Object.defineProperty(this, 'width', {
      configurable: true,
      get: () => width,
      set: (value: number) => {
        width = value;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      },
    });
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<JarvisParticleFigure status={initial} />));

  return {
    ctx,
    frames,
    get rafCalls() {
      return rafCalls;
    },
    /** Tempo virtual atual, em segundos. */
    now: () => clock / 1000,
    /** Avança o relógio em quadros de 60 fps; `onFrame` vê cada quadro pintado. */
    advance(ms: number, onFrame?: (arcs: DrawnArc[], t: number) => void) {
      const steps = Math.round(ms / FRAME_MS);
      for (let i = 0; i < steps; i += 1) {
        clock += FRAME_MS;
        const callbacks = [...rafQueue.values()];
        rafQueue.clear();
        for (const cb of callbacks) cb(clock);
        onFrame?.(current, clock / 1000);
      }
    },
    resize(px: number) {
      size = px;
      act(() => {
        for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
      });
    },
    setStatus(status: VoiceUiStatus) {
      act(() => root.render(<JarvisParticleFigure status={status} />));
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      delete (HTMLCanvasElement.prototype as { clientWidth?: number }).clientWidth;
    },
  };
}

const painted = (arcs: DrawnArc[] | undefined) => (arcs ?? []).filter((a) => a.kind === 'fill');

describe('JarvisParticleFigure — movimento reduzido (quadro estático)', () => {
  let figure: ReturnType<typeof mountFigure> | null = null;
  afterEach(() => {
    figure?.unmount();
    figure = null;
  });

  it('pinta UMA vez a silhueta formada na posição de repouso, não a nuvem espalhada', () => {
    figure = mountFigure('idle', { reduced: true, size: 200 });
    expect(figure.rafCalls).toBe(0); // sem loop
    expect(figure.frames).toHaveLength(1);

    const count = particleCountForSize(200);
    const homes = buildHumanSilhouette(count);
    const arcs = painted(figure.frames[0]);
    // O corpo inteiro e, depois dele, os lábios da boca fechada.
    expect(arcs).toHaveLength(count + mouthParticleCount(count));
    arcs.slice(0, count).forEach((arc, i) => {
      expect(arc.x).toBeCloseTo(homes[i]!.x * 200, 6);
      expect(arc.y).toBeCloseTo(homes[i]!.y * 200, 6);
    });
    const ring = buildMouthRing(mouthParticleCount(count));
    arcs.slice(count).forEach((arc, i) => {
      const lip = lipPoint(ring[i]!, 0, 0);
      expect(arc.x).toBeCloseTo(lip.x * 200, 6);
      expect(arc.y).toBeCloseTo(lip.y * 200, 6);
    });
    expect(figure.ctx.globalCompositeOperation).toBe('lighter');
  });

  it('repinta na troca de estado: o erro usa a cor de perigo e o quadro segue formado', () => {
    figure = mountFigure('idle', { reduced: true, size: 200 });
    const idleFill = painted(figure.frames.at(-1))[0]!.fill;

    figure.setStatus('error');
    expect(figure.frames).toHaveLength(2);
    const errorArcs = painted(figure.frames.at(-1));
    expect(errorArcs[0]!.fill).not.toBe(idleFill);
    // Mesmo no erro o quadro estático é a silhueta formada (sem dispersão).
    const homes = buildHumanSilhouette(particleCountForSize(200));
    expect(errorArcs[0]!.x).toBeCloseTo(homes[0]!.x * 200, 6);

    figure.setStatus('listening');
    expect(figure.frames).toHaveLength(3);
    expect(painted(figure.frames.at(-1))[0]!.fill).toBe(idleFill);
    expect(figure.rafCalls).toBe(0);
  });

  it('repinta no resize, na posição de repouso do novo tamanho, sem perder o brilho aditivo', () => {
    figure = mountFigure('speaking', { reduced: true, size: 160 });
    figure.resize(240);

    expect(figure.frames).toHaveLength(2);
    const homes = buildHumanSilhouette(particleCountForSize(160)); // contagem fixa no mount
    const arcs = painted(figure.frames.at(-1));
    expect(arcs).toHaveLength(homes.length + mouthParticleCount(homes.length));
    arcs.slice(0, homes.length).forEach((arc, i) => {
      expect(arc.x).toBeCloseTo(homes[i]!.x * 240, 6);
      expect(arc.y).toBeCloseTo(homes[i]!.y * 240, 6);
    });
    // O resize zerou o contexto; a composição aditiva tem de voltar.
    expect(figure.ctx.globalCompositeOperation).toBe('lighter');
  });
});

describe('JarvisParticleFigure — loop animado', () => {
  let figure: ReturnType<typeof mountFigure> | null = null;
  afterEach(() => {
    figure?.unmount();
    figure = null;
  });

  it('o resize re-seta a composição aditiva na hora (não espera o próximo quadro)', () => {
    figure = mountFigure('idle', { size: 160 });
    figure.advance(200);
    expect(figure.ctx.globalCompositeOperation).toBe('lighter');

    figure.resize(220);
    expect(figure.ctx.globalCompositeOperation).toBe('lighter');
  });

  it('o resize só reescala: não re-dispersa as partículas nem muda a contagem', () => {
    figure = mountFigure('listening', { size: 160 });
    figure.advance(3000);
    const before = painted(figure.frames.at(-1)).map((a) => ({ x: a.x, y: a.y }));
    figure.resize(320);
    figure.advance(FRAME_MS);
    const after = painted(figure.frames.at(-1));
    expect(after).toHaveLength(before.length);
    // Dobrou o canvas: cada partícula continua no mesmo ponto relativo.
    const drift = after.map((a, i) => Math.hypot(a.x - before[i]!.x * 2, a.y - before[i]!.y * 2));
    expect(Math.max(...drift) / 320).toBeLessThan(0.03);
  });
});

describe('JarvisParticleFigure — o ocioso é uma silhueta reconhecível', () => {
  let figure: ReturnType<typeof mountFigure> | null = null;
  afterEach(() => {
    figure?.unmount();
    figure = null;
  });

  /** Distância de cada partícula à sua casa na silhueta, em fração do canvas. */
  function displacement(arcs: DrawnArc[], homes: ReturnType<typeof buildHumanSilhouette>, size: number) {
    // Só o corpo: os lábios vêm depois dele no mesmo quadro.
    const fills = painted(arcs).slice(0, homes.length);
    return fills.map((a, i) => Math.hypot(a.x - homes[i]!.x * size, a.y - homes[i]!.y * size) / size);
  }

  it('segura a forma humana em todo o ciclo, fecha no pico e abre (parcialmente) no vale', () => {
    const size = 180;
    figure = mountFigure('idle', { size });
    const homes = buildHumanSilhouette(particleCountForSize(size));
    figure.advance(4000); // nasce espalhada: dá tempo de assentar na silhueta

    const near = 0.06; // 6% do lado: ainda lê como parte do mesmo corpo
    const samples: { t: number; within: number; mean: number; aspect: number }[] = [];
    figure.advance(IDLE_CYCLE_S * 2 * 1000, (arcs, t) => {
      const d = displacement(arcs, homes, size);
      const xs = painted(arcs).slice(0, homes.length).map((a) => a.x);
      const ys = painted(arcs).slice(0, homes.length).map((a) => a.y);
      samples.push({
        t,
        within: d.filter((v) => v <= near).length / d.length,
        mean: d.reduce((a, b) => a + b, 0) / d.length,
        aspect: (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs)),
      });
    });
    const within = samples.map((s) => s.within);
    const mean = samples.map((s) => s.mean);
    // Reconhecível o tempo todo: a antiga nuvem tinha ~0% perto da casa.
    expect(Math.min(...within)).toBeGreaterThanOrEqual(0.93);
    // Pico: a figura fecha (quase todas as partículas na casa).
    expect(Math.max(...within)).toBeGreaterThanOrEqual(0.98);
    // Dissolução parcial periódica: o vale é mensuravelmente mais poroso que o pico.
    expect(Math.max(...mean)).toBeGreaterThan(Math.min(...mean) * 3);
    // E o corpo continua em pé em TODO quadro: bem mais alto que largo.
    expect(Math.min(...samples.map((s) => s.aspect))).toBeGreaterThan(1.4);
  });

  it('as pontas (mãos e pés) se soltam mais que o núcleo no vale e se refazem no pico', () => {
    const size = 180;
    figure = mountFigure('idle', { size });
    const homes = buildHumanSilhouette(particleCountForSize(size));
    figure.advance(4000);

    const core: number[] = [];
    const tips: number[] = [];
    homes.forEach((p, i) => (p.tip === 0 ? core : p.tip > 0.7 ? tips : []).push(i));
    expect(core.length).toBeGreaterThan(20);
    expect(tips.length).toBeGreaterThan(10);

    const meanAt = (idx: number[], arcs: DrawnArc[]) => {
      const d = displacement(arcs, homes, size);
      return idx.reduce((sum, i) => sum + d[i]!, 0) / idx.length;
    };
    const tipMean: number[] = [];
    const coreMean: number[] = [];
    figure.advance(IDLE_CYCLE_S * 2 * 1000, (arcs) => {
      tipMean.push(meanAt(tips, arcs));
      coreMean.push(meanAt(core, arcs));
    });

    // As pontas desfazem e refazem: oscilam bem mais que o núcleo.
    const swing = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(swing(tipMean)).toBeGreaterThan(swing(coreMean) * 2);
    // No vale a ponta está claramente mais solta que o núcleo...
    expect(Math.max(...tipMean)).toBeGreaterThan(Math.max(...coreMean) * 2);
    // ...e no pico volta a fechar junto da casa.
    expect(Math.min(...tipMean)).toBeLessThan(0.02);
    // O núcleo (cabeça/tronco) nunca se desfaz a ponto de perder o contorno.
    expect(Math.max(...coreMean)).toBeLessThan(0.03);
  });
});

describe('JarvisParticleFigure — o nível que move a figura vem da fonte certa', () => {
  let figure: ReturnType<typeof mountFigure> | null = null;

  afterEach(() => {
    figure?.unmount();
    figure = null;
    act(() => {
      useVoiceStore.setState({ status: 'idle', level: 0, outputLevel: 0 });
    });
  });

  /** Alpha médio das partículas nos últimos `frames` quadros pintados. */
  const meanAlphaOf = (fig: ReturnType<typeof mountFigure>, frames: number) => {
    const recent = fig.frames.slice(-frames);
    const alphas = recent.flatMap((arcs) => painted(arcs).map((a) => a.alpha));
    return alphas.reduce((a, b) => a + b, 0) / alphas.length;
  };

  it('falando: o brilho segue o nível da própria voz (saída), não o microfone', () => {
    figure = mountFigure('speaking', { size: 180 });
    act(() => {
      useVoiceStore.setState({ level: 0, outputLevel: 0.03 });
    });
    figure.advance(1200);
    const quiet = meanAlphaOf(figure, 30);

    act(() => {
      useVoiceStore.setState({ outputLevel: 1 });
    });
    figure.advance(1200);
    const loud = meanAlphaOf(figure, 30);

    expect(loud).toBeGreaterThan(quiet + 0.05); // alpha soma level*0.2 + energia*0.12
  });

  it('ouvindo: o nível vem do microfone, ainda que a saída esteja alta', () => {
    figure = mountFigure('listening', { size: 180 });
    act(() => {
      useVoiceStore.setState({ level: 0.02, outputLevel: 1 });
    });
    figure.advance(1200);
    const quiet = meanAlphaOf(figure, 30);

    act(() => {
      useVoiceStore.setState({ level: 0.95 });
    });
    figure.advance(1200);
    const loud = meanAlphaOf(figure, 30);

    expect(loud).toBeGreaterThan(quiet + 0.05); // alpha soma level*0.2 (mic)
  });
});

describe('boca — funções puras', () => {
  it('mouthParticleCount: anel pequeno, com piso e teto', () => {
    expect(mouthParticleCount(0)).toBe(0);
    expect(mouthParticleCount(120)).toBe(10);
    expect(mouthParticleCount(360)).toBe(16);
    expect(mouthParticleCount(5000)).toBe(16);
  });

  it('buildMouthRing é determinístico e dá a volta inteira (lábio de cima, de baixo e cantos)', () => {
    const ring = buildMouthRing(16);
    expect(ring).toEqual(buildMouthRing(16));
    expect(ring.filter((a) => Math.sin(a) < -0.5).length).toBeGreaterThan(3); // superior
    expect(ring.filter((a) => Math.sin(a) > 0.5).length).toBeGreaterThan(3); // inferior
    expect(ring.filter((a) => Math.abs(Math.cos(a)) > 0.9).length).toBeGreaterThan(1); // cantos
  });

  it('lipPoint: fechada é uma linha; aberta afasta os lábios, mais o de baixo (mandíbula)', () => {
    const top = -Math.PI / 2;
    const bottom = Math.PI / 2;
    expect(lipPoint(top, 0, 0).y).toBeCloseTo(MOUTH_CENTER.y - MOUTH_CLOSED_HALF_HEIGHT, 10);
    expect(lipPoint(bottom, 0, 0).y).toBeCloseTo(MOUTH_CENTER.y + MOUTH_CLOSED_HALF_HEIGHT, 10);
    expect(lipPoint(0, 0, 0).x).toBeCloseTo(MOUTH_CENTER.x + MOUTH_HALF_WIDTH, 10);

    const up = MOUTH_CENTER.y - lipPoint(top, 1, 0).y;
    const down = lipPoint(bottom, 1, 0).y - MOUTH_CENTER.y;
    expect(down).toBeGreaterThan(up); // o lábio inferior desce com o queixo
    expect(up + down).toBeGreaterThan(MOUTH_CLOSED_HALF_HEIGHT * 2 * 5);
  });

  it('lipPoint: "s"/"i" estica a boca e estreita a abertura', () => {
    const corner = (wide: number) => lipPoint(0, 0.6, wide).x - MOUTH_CENTER.x;
    expect(corner(1)).toBeGreaterThan(corner(0) * 1.25);
    const gap = (wide: number) => lipPoint(Math.PI / 2, 0.6, wide).y - lipPoint(-Math.PI / 2, 0.6, wide).y;
    expect(gap(1)).toBeLessThan(gap(0));
  });

  it('mouthShape medido: volume abre, brilho estica, silêncio fecha', () => {
    const loudA = mouthShape(0.8, 0.05, 0, true);
    const quiet = mouthShape(0.2, 0.05, 0, true);
    const loudS = mouthShape(0.8, 0.95, 0, true);
    expect(loudA.open).toBeGreaterThan(quiet.open);
    expect(quiet.open).toBeGreaterThan(0.1); // fala baixa ainda mexe a boca
    expect(loudS.wide).toBeGreaterThan(loudA.wide);
    expect(loudS.open).toBeLessThan(loudA.open);
    expect(mouthShape(0, 0.5, 3, true).open).toBe(0); // pausa medida
    for (const v of [loudA, quiet, loudS]) {
      expect(v.open).toBeLessThanOrEqual(1);
      expect(v.wide).toBeLessThanOrEqual(1);
    }
  });

  it('mouthShape sem medida: sílabas sintéticas abrem e fecham ~4 vezes por segundo', () => {
    const opens = Array.from({ length: 120 }, (_, i) => mouthShape(0, 0, i / 60, false).open);
    expect(Math.max(...opens)).toBeGreaterThan(0.5);
    expect(Math.min(...opens)).toBe(0); // fecha entre as sílabas
    let rises = 0;
    for (let i = 1; i < opens.length; i += 1) if (opens[i - 1] === 0 && opens[i]! > 0) rises += 1;
    expect(rises).toBeGreaterThanOrEqual(5); // 2 s ≈ 8 sílabas, algumas fundidas
    expect(rises).toBeLessThanOrEqual(10);
  });

  it('mouthDeform abre um vão: nenhum ponto do rosto fica entre os lábios da boca aberta', () => {
    const open = 1;
    const upperLip = lipPoint(-Math.PI / 2, open, 0).y;
    const lowerLip = lipPoint(Math.PI / 2, open, 0).y;
    let inside = 0;
    let moved = 0;
    for (let x = 0.47; x <= 0.53; x += 0.002) {
      for (let y = 0.17; y <= 0.235; y += 0.001) {
        const d = mouthDeform(x, y, open, 0);
        if (d.y !== 0) moved += 1;
        const ny = y + d.y;
        // O miolo do vão (60% central entre os lábios) fica livre.
        const mid = (upperLip + lowerLip) / 2;
        const half = ((lowerLip - upperLip) / 2) * 0.6;
        if (Math.abs(x - MOUTH_CENTER.x) < 0.01 && Math.abs(ny - mid) < half) inside += 1;
      }
    }
    expect(moved).toBeGreaterThan(100);
    expect(inside).toBe(0);
  });

  it('mouthDeform: o queixo desce com a mandíbula; fora da cabeça e boca fechada nada muda', () => {
    expect(mouthDeform(0.5, 0.235, 1, 0).y).toBeGreaterThan(0); // queixo
    expect(mouthDeform(0.5, 0.235, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(mouthDeform(0.5, 0.4, 1, 1)).toEqual({ x: 0, y: 0 }); // peito
    expect(Math.abs(mouthDeform(0.5, 0.09, 1, 0).y)).toBeLessThan(0.001); // testa quase parada
  });

  it('smoothMouth abre mais rápido do que fecha', () => {
    const opened = smoothMouth({ open: 0, wide: 0 }, { open: 1, wide: 0 }, FRAME_MS);
    const closed = smoothMouth({ open: 1, wide: 0 }, { open: 0, wide: 0 }, FRAME_MS);
    expect(opened.open).toBeGreaterThan(1 - closed.open);
    expect(opened.open).toBeLessThan(1);
  });
});

describe('JarvisParticleFigure — a boca fala com a voz', () => {
  let figure: ReturnType<typeof mountFigure> | null = null;

  afterEach(() => {
    figure?.unmount();
    figure = null;
    act(() => {
      useVoiceStore.setState({ status: 'idle', level: 0, outputLevel: 0, outputBrightness: 0 });
    });
  });

  /** Altura (fração do canvas) do anel de lábios num quadro pintado. */
  const lipHeight = (arcs: DrawnArc[], size: number) => {
    const count = particleCountForSize(size);
    const lips = painted(arcs).slice(count);
    const ys = lips.map((a) => a.y);
    return (Math.max(...ys) - Math.min(...ys)) / size;
  };

  it('abre com a voz alta e fecha na pausa medida', () => {
    const size = 200;
    figure = mountFigure('speaking', { size });
    figure.advance(1500); // assenta a figura
    act(() => {
      useVoiceStore.setState({ outputLevel: 0.85, outputBrightness: 0.05 });
    });
    figure.advance(700);
    const open = lipHeight(figure.frames.at(-1)!, size);

    act(() => {
      useVoiceStore.setState({ outputLevel: 0, outputBrightness: 0 });
    });
    figure.advance(700);
    const paused = lipHeight(figure.frames.at(-1)!, size);

    expect(open).toBeGreaterThan(0.03);
    expect(paused).toBeLessThan(open * 0.4);
    expect(paused).toBeLessThan(MOUTH_CLOSED_HALF_HEIGHT * 2 + 0.006);
  });

  it('sem medidor: boca fechada na carência, depois sílabas sintéticas', () => {
    const size = 200;
    // Ouvindo o corpo fica inteiro (sem a poeira do ocioso): assenta antes de falar.
    figure = mountFigure('listening', { size });
    figure.advance(3000);
    figure.setStatus('speaking');
    const early: number[] = [];
    figure.advance(SYNTHETIC_MOUTH_GRACE_S * 1000 * 0.6, (arcs) => early.push(lipHeight(arcs, size)));
    figure.advance(1500);
    const later: number[] = [];
    figure.advance(1500, (arcs) => later.push(lipHeight(arcs, size)));

    expect(Math.max(...later) - Math.min(...later)).toBeGreaterThan(0.015); // abre e fecha
    expect(Math.max(...early)).toBeLessThan(MOUTH_CLOSED_HALF_HEIGHT * 2 + 0.006); // carência: fechada
    expect(Math.max(...later)).toBeGreaterThan(Math.max(...early) + 0.01);
  });

  it('fora da fala a boca fica fechada (ouvindo, ainda que a saída esteja alta)', () => {
    const size = 200;
    figure = mountFigure('listening', { size });
    act(() => {
      useVoiceStore.setState({ level: 0.9, outputLevel: 1, outputBrightness: 0 });
    });
    figure.advance(2000);
    // Ouvindo o corpo é puxado para dentro: a altura dos lábios encolhe junto.
    expect(lipHeight(figure.frames.at(-1)!, size)).toBeLessThan(0.015);
  });
});
