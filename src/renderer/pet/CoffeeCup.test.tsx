/** @vitest-environment jsdom */
/**
 * A lata tem que ler como energético (cilindro, tampa, slash, NEXUS) — não caneca.
 * O derrame é pour curto no canto, nunca uma onda do teto ao chão.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CoffeeCup, CoffeeSpillCorner } from './CoffeeCup';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots = new Set<Root>();

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(node);
  });
  return host;
}

function viewBoxSize(svg: SVGElement | null): { w: number; h: number } {
  const parts = (svg?.getAttribute('viewBox') ?? '0 0 0 0').split(/\s+/);
  return { w: Number(parts[2]), h: Number(parts[3]) };
}

function pathCoords(d: string): { x: number; y: number }[] {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

function pathYs(d: string): number[] {
  return pathCoords(d).map((pt) => pt.y);
}

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
});

describe('CoffeeCup — silhueta de lata', () => {
  it('é um cilindro mais alto que largo, com corpo, slash, tampa e lacre', () => {
    const host = render(<CoffeeCup size={52} />);
    const svg = host.querySelector<SVGElement>('svg.pet-coffee');
    expect(svg, 'lata SVG ausente').not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('.pet-coffee__body')).not.toBeNull();
    expect(svg?.querySelector('.pet-coffee__band')).not.toBeNull();
    expect(svg?.querySelector('.pet-coffee__lid')).not.toBeNull();
    expect(svg?.querySelector('.pet-coffee__mouth')).not.toBeNull();
    expect(svg?.querySelector('.pet-coffee__tab')).not.toBeNull();
    expect(svg?.querySelector('.pet-coffee__fizz')).not.toBeNull();

    const box = viewBoxSize(svg);
    expect(box.h / box.w, 'lata não é cilíndrica (alta)').toBeGreaterThanOrEqual(1.8);
    expect(Number(svg?.getAttribute('height'))).toBe(52);
  });

  it('lacre mora em cima da tampa, não é alça de caneca', () => {
    const host = render(<CoffeeCup size={52} />);
    const ring = host.querySelector('.pet-coffee__tab-ring');
    expect(ring, 'anel do lacre ausente').not.toBeNull();
    const cx = Number(ring?.getAttribute('cx'));
    const box = viewBoxSize(host.querySelector('svg.pet-coffee'));
    expect(cx, 'lacre deslocado para o lado como alça').toBeGreaterThanOrEqual(box.w / 2 - 2);
    expect(cx, 'lacre deslocado para o lado como alça').toBeLessThanOrEqual(box.w / 2 + 2);
    expect(host.querySelector('.pet-coffee__handle')).toBeNull();
    expect(host.querySelector('.pet-coffee__steam')).toBeNull();
  });

  it('não desenha path de vapor — fizz é bolha na boca, não onda', () => {
    const host = render(<CoffeeCup size={52} />);
    const fizz = [...host.querySelectorAll('.pet-coffee__fizz')];
    expect(fizz.length).toBeGreaterThanOrEqual(2);
    for (const node of fizz) {
      expect(node.tagName.toLowerCase()).toBe('circle');
    }
    expect(host.querySelector('path.pet-coffee__fizz')).toBeNull();
  });

  it('faixa operacional é slash diagonal, não rótulo horizontal', () => {
    const host = render(<CoffeeCup size={52} />);
    const band = host.querySelector('.pet-coffee__band');
    expect(band?.tagName.toLowerCase()).toBe('path');
    const pts = pathCoords(band?.getAttribute('d') ?? '');
    const dx = Math.max(...pts.map((pt) => pt.x)) - Math.min(...pts.map((pt) => pt.x));
    const dy = Math.max(...pts.map((pt) => pt.y)) - Math.min(...pts.map((pt) => pt.y));
    expect(dx, 'slash curto demais no eixo x').toBeGreaterThanOrEqual(16);
    expect(dy, 'slash não desce na diagonal').toBeGreaterThanOrEqual(12);
  });

  it('leva wordmark NEXUS e selo energético nosso — sem marca terceira', () => {
    const host = render(<CoffeeCup size={52} />);
    const mark = host.querySelector('.pet-coffee__mark');
    expect(mark, 'wordmark NEXUS ausente').not.toBeNull();
    expect(mark?.getAttribute('data-word')).toBe('NEXUS');
    expect(mark?.textContent).toBe('NEXUS');
    expect(host.querySelector('.pet-coffee__seal-ring'), 'anel do selo ausente').not.toBeNull();
    expect(host.querySelector('.pet-coffee__seal-bolt'), 'raio do selo ausente').not.toBeNull();
    expect(host.querySelector('.pet-coffee__claw')).toBeNull();
    expect(host.textContent ?? '').not.toMatch(/monster/i);
  });
});

describe('CoffeeSpillCorner — pour curto', () => {
  it('cabe no canto: viewBox e altura ≤ 80px', () => {
    const host = render(<CoffeeSpillCorner />);
    const svg = host.querySelector<SVGElement>('svg.spill-corner');
    expect(svg).not.toBeNull();
    const box = viewBoxSize(svg);
    expect(box.h, 'viewBox do derrame voltou a ser do teto ao chão').toBeLessThanOrEqual(80);
    expect(Number(svg?.getAttribute('height'))).toBeLessThanOrEqual(80);
    expect(svg?.querySelector('.spill__can')).not.toBeNull();
    expect(svg?.querySelector('.spill__pool')).not.toBeNull();
  });

  it('filete cai pouco — um arco, não rabisco vertical', () => {
    const host = render(<CoffeeSpillCorner />);
    const stream = host.querySelector('.spill__stream--body');
    expect(stream).not.toBeNull();
    const ys = pathYs(stream?.getAttribute('d') ?? '');
    expect(ys.length).toBeGreaterThanOrEqual(2);
    const drop = Math.max(...ys) - Math.min(...ys);
    expect(drop, 'filete longo demais para um pour de canto').toBeLessThanOrEqual(50);
    expect(Math.max(...ys), 'filete sai do viewBox compacto').toBeLessThanOrEqual(76);
  });
});
