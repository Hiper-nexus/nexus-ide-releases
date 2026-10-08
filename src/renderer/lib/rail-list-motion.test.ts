// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: fixture TestRow/TestAnimation de apps/web/src/components/Sidebar.motion.test.ts (sem o arraste), com casos de deslocamento, clone de saída inerte sem ids, orçamento de 40 itens animados, prefers-reduced-motion, dispose e linhas com canvas/xterm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ANIMATED_ROWS_PER_UPDATE, createRailListMotion } from './rail-list-motion';

const TIMING = { duration: 180, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' };

class TestAnimation {
  progress: number | null = 0;
  playState: AnimationPlayState = 'running';
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  cancel = vi.fn(() => {
    this.playState = 'idle';
  });
  private onFinish: (() => void) | undefined;
  addEventListener(_type: string, listener: () => void) {
    this.onFinish = listener;
  }
  finish() {
    this.playState = 'finished';
    this.onFinish?.();
  }
}

class TestRow {
  offsetTop = 0;
  offsetLeft = 4;
  offsetWidth = 230;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  style: Record<string, string> = {};
  inert = false;
  attributes: { name: string; value: string }[] = [];
  children: TestRow[] = [];
  clones: TestRow[] = [];
  /** Linha com terminal/canvas dentro (o fixture não tem seletor real). */
  hasCanvas = false;
  remove = vi.fn();
  animations: TestAnimation[] = [];
  constructor(
    readonly name: string,
    public offsetHeight = 40,
  ) {}
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  getAttribute(name: string) {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }
  matches(_selector: string) {
    return false;
  }
  querySelector(_selector: string) {
    return this.hasCanvas ? this : null;
  }
  querySelectorAll(_selector: string): TestRow[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
  }
  cloneNode(_deep: boolean): TestRow {
    const clone = new TestRow(`${this.name} clone`, this.offsetHeight);
    clone.namespaceURI = this.namespaceURI;
    clone.style = { ...this.style };
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.children = this.children.map((child) => child.cloneNode(true));
    this.clones.push(clone);
    return clone;
  }
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  });
}

function fixture(rows: TestRow[]) {
  const media = { matches: false };
  const parent = {
    children: rows,
    ownerDocument: { defaultView: { matchMedia: () => media } },
    animate: () => undefined,
    append(node: TestRow) {
      parent.children.push(node);
      node.remove.mockImplementation(() => {
        parent.children = parent.children.filter((child) => child !== node);
      });
    },
  };
  function layout(next: TestRow[]) {
    let top = 0;
    for (const row of next) {
      row.offsetTop = top;
      top += row.offsetHeight + 4;
    }
    parent.children = [
      ...next,
      ...parent.children.filter((row) => row.style.position === 'absolute'),
    ];
  }
  layout(rows);
  const motion = createRailListMotion(parent as unknown as HTMLElement);
  return { motion, layout, media, parent };
}

function expectMove(row: TestRow, offset: number) {
  expect(row.animate).toHaveBeenLastCalledWith(
    [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0px)' }],
    TIMING,
  );
}

// `HTMLElement` vira TestRow: o filtro `instanceof` do módulo aceita o fixture.
// Por isso as asserções usam `includes` e não `toContain` (que trata o valor
// como nó DOM de verdade).
beforeEach(() => vi.stubGlobal('HTMLElement', TestRow));
afterEach(() => vi.unstubAllGlobals());

describe('movimento das listas da rail', () => {
  it('desliza missões que trocam de lugar a partir da posição antiga', () => {
    const [a, b, c] = [new TestRow('a'), new TestRow('b'), new TestRow('c')];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    expect([a, b, c].every((row) => row.animations.length === 0)).toBe(true);

    layout([c, a, b]);
    motion.update(true);
    expectMove(c, 88);
    expectMove(a, -44);
    expectMove(b, -44);
  });

  it('entra com opacidade e deriva de no máximo 4px; abaixo de vizinho parado só aparece', () => {
    const [a, b, c] = [new TestRow('a'), new TestRow('b'), new TestRow('c')];
    const { motion, layout } = fixture([a]);
    motion.update(true);
    layout([b, a, c]);
    motion.update(true);
    expect(b.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'translateY(0px)' },
      ],
      TIMING,
    );
    expectMove(a, -44);
    // c chega junto do bloco que a carrega (mesmo deslocamento de a).
    expect(c.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: 'translateY(-44px)' },
        { opacity: 1, transform: 'translateY(0px)' },
      ],
      TIMING,
    );
  });

  it('a saída usa um clone inerte, aria-hidden e sem ids nem ganchos de ação', () => {
    const [a, b] = [new TestRow('a'), new TestRow('b')];
    a.setAttribute('id', 'mission-a');
    a.setAttribute('data-mission-id', 'm-a');
    a.setAttribute('class', 'workspace-rail__mission-card-item');
    const button = new TestRow('button');
    button.setAttribute('id', 'remove-a');
    button.setAttribute('data-action', 'remove-mission');
    button.setAttribute('data-workspace-id', 'w1');
    button.setAttribute('data-testid', 'remove');
    button.setAttribute('aria-label', 'Remover missão A');
    const svg = new TestRow('svg');
    svg.namespaceURI = 'http://www.w3.org/2000/svg';
    svg.setAttribute('id', 'pixel-gradient');
    button.children = [svg];
    a.children = [button];
    const { motion, layout, parent } = fixture([a, b]);
    motion.update(true);

    layout([b]);
    motion.update(true);
    const clone = a.clones[0]!;
    expect(parent.children.includes(clone)).toBe(true);
    expect(clone.inert).toBe(true);
    expect(clone.getAttribute('aria-hidden')).toBe('true');
    expect(clone.getAttribute('id')).toBeNull();
    expect(clone.getAttribute('data-mission-id')).toBeNull();
    expect(clone.getAttribute('class')).toBe('workspace-rail__mission-card-item');
    const clonedButton = clone.children[0]!;
    for (const hook of ['id', 'data-action', 'data-workspace-id', 'data-testid']) {
      expect(clonedButton.getAttribute(hook), hook).toBeNull();
    }
    expect(clonedButton.getAttribute('aria-label')).toBe('Remover missão A');
    // Ids de SVG ficam: referências url(#…) internas ao clone.
    expect(clonedButton.children[0]!.getAttribute('id')).toBe('pixel-gradient');
    expect(clone.style).toMatchObject({
      position: 'absolute',
      top: '0px',
      pointerEvents: 'none',
    });
    expect(clone.animate).toHaveBeenCalledWith(
      [
        { opacity: 1, transform: 'translateY(0px)' },
        { opacity: 0, transform: 'translateY(4px)' },
      ],
      TIMING,
    );
    // O original (de quem o React é dono) não é tocado.
    expect(a.getAttribute('id')).toBe('mission-a');

    clone.animations[0]!.finish();
    expect(parent.children.includes(clone)).toBe(false);
  });

  it(`acima de ${MAX_ANIMATED_ROWS_PER_UPDATE} itens animados a atualização só encaixa`, () => {
    const rows = Array.from({ length: 30 }, (_, index) => new TestRow(`r${index}`));
    const { motion, layout } = fixture(rows);
    motion.update(true);
    // 30 deslocados + 11 entrando = 41 animações: passa do orçamento.
    const incoming = Array.from({ length: 11 }, (_, index) => new TestRow(`n${index}`));
    layout([...incoming, ...rows]);
    motion.update(true);
    expect([...rows, ...incoming].every((row) => row.animations.length === 0)).toBe(true);

    // Exatamente no orçamento (40) ainda anima.
    const few = Array.from({ length: 10 }, (_, index) => new TestRow(`f${index}`));
    const { motion: second, layout: relayout } = fixture(rows);
    second.update(true);
    relayout([...few, ...rows]);
    second.update(true);
    expect(rows.every((row) => row.animations.length === 1)).toBe(true);
  });

  it('cancela movimento em curso quando a atualização em massa encaixa', () => {
    const [a, b] = [new TestRow('a'), new TestRow('b')];
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    const first = a.animations[0]!;
    first.progress = 0.4;
    layout(Array.from({ length: 41 }, (_, index) => new TestRow(`new-${index}`)));
    motion.update(true);
    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it('prefers-reduced-motion cancela o que está em curso e não anima', () => {
    const [a, b, c] = [new TestRow('a'), new TestRow('b'), new TestRow('c')];
    const { motion, layout, media, parent } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    const inFlight = b.animations[0]!;

    media.matches = true;
    layout([a, c]);
    motion.update(true);
    expect(inFlight.cancel).toHaveBeenCalledOnce();
    expect(c.animations).toHaveLength(0);
    expect(b.clones).toHaveLength(0);
    expect(parent.children.some((row) => row.style.position === 'absolute')).toBe(false);
  });

  it('dispose cancela, remove os clones e nunca mais anima', () => {
    const [a, b, c] = [new TestRow('a'), new TestRow('b'), new TestRow('c')];
    const { motion, layout, parent } = fixture([a, b, c]);
    motion.update(true);
    layout([c, b]);
    motion.update(true);
    const move = c.animations[0]!;
    const clone = a.clones[0]!;
    expect(parent.children.includes(clone)).toBe(true);

    motion.dispose();
    expect(move.cancel).toHaveBeenCalledOnce();
    expect(clone.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(parent.children.includes(clone)).toBe(false);

    layout([a, b, c]);
    motion.update(true);
    expect(a.animate).not.toHaveBeenCalled();
    expect(b.animate).not.toHaveBeenCalled();
    expect(c.animations).toHaveLength(1);
  });

  it('nunca anima nem clona linha com canvas/xterm', () => {
    const [a, b] = [new TestRow('a'), new TestRow('terminal')];
    b.hasCanvas = true;
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    expect(b.animate).not.toHaveBeenCalled();
    expectMove(a, -44);
    layout([a]);
    motion.update(true);
    expect(b.clones).toHaveLength(0);
  });

  it('sem Web Animations (jsdom) só mede, sem quebrar', () => {
    const [a, b] = [new TestRow('a'), new TestRow('b')];
    const { parent, layout } = fixture([a, b]);
    const bare = { ...parent, animate: undefined, ownerDocument: { defaultView: {} } };
    const motion = createRailListMotion(bare as unknown as HTMLElement);
    motion.update(false);
    layout([b, a]);
    bare.children = parent.children;
    expect(() => motion.update(true)).not.toThrow();
    expect(a.animate).not.toHaveBeenCalled();
  });
});
