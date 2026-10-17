/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHumanSilhouette,
  cohesionForStatus,
  JarvisParticleFigure,
  mulberry32,
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
