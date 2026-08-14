/** @vitest-environment jsdom */
/**
 * Garante que ChosenPetPortrait — o chrome comum de todo pet —
 * sempre renderiza a lata cafeinada, independente do skin escolhido.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChosenPetPortrait } from './ChosenPetPortrait';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots = new Set<Root>();

function renderPortrait(size = 96): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <ChosenPetPortrait
        size={size}
        className="test-portrait"
        fallbackTier="RECRUTA"
        fallbackBranch="base"
        fallbackSkin={null}
      />,
    );
  });
  return host;
}

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
});

describe('ChosenPetPortrait — lata cafeinada em todo pet', () => {
  it('renderiza svg.pet-coffee dentro do retrato', () => {
    const host = renderPortrait(96);
    const cup = host.querySelector('svg.pet-coffee');
    expect(cup, 'lata SVG ausente no retrato').not.toBeNull();
    expect(cup?.querySelector('.pet-coffee__body'), 'corpo da lata ausente').not.toBeNull();
    expect(cup?.querySelector('.pet-coffee__band'), 'faixa da lata ausente').not.toBeNull();
  });

  it('lata é aria-hidden (decorativa)', () => {
    const host = renderPortrait(96);
    const cup = host.querySelector('svg.pet-coffee');
    expect(cup?.getAttribute('aria-hidden')).toBe('true');
  });

  it('lata escala com size=96: tamanho ≥ 40px', () => {
    const host = renderPortrait(96);
    const cup = host.querySelector<SVGElement>('svg.pet-coffee');
    const h = Number(cup?.getAttribute('height') ?? 0);
    expect(h, 'lata menor que 40px para retrato 96px').toBeGreaterThanOrEqual(40);
  });

  it('lata escala com size=32: entre 12px e 14px, sem vazar o HUD', () => {
    const host = renderPortrait(32);
    const wrapper = host.querySelector('.chosen-pet-portrait--compact');
    const cup = host.querySelector<SVGElement>('svg.pet-coffee');
    const h = Number(cup?.getAttribute('height') ?? 0);
    expect(wrapper, 'retrato compacto sem classe --compact').not.toBeNull();
    expect(h, 'lata menor que 12px para retrato 32px').toBeGreaterThanOrEqual(12);
    expect(h, 'lata grande demais no HUD').toBeLessThanOrEqual(14);
  });

  it('wrapper tem classe chosen-pet-portrait + className extra', () => {
    const host = renderPortrait(96);
    const wrapper = host.querySelector('.chosen-pet-portrait');
    expect(wrapper, 'wrapper .chosen-pet-portrait ausente').not.toBeNull();
    expect(wrapper?.classList.contains('test-portrait')).toBe(true);
  });

  it('lata está dentro do wrapper .chosen-pet-portrait__coffee', () => {
    const host = renderPortrait(96);
    const badge = host.querySelector('.chosen-pet-portrait__coffee');
    expect(badge, 'badge .chosen-pet-portrait__coffee ausente').not.toBeNull();
    const cup = badge?.querySelector('svg.pet-coffee');
    expect(cup, 'lata fora do badge de cafeína').not.toBeNull();
  });
});
