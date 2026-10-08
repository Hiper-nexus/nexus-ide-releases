/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActivityTimeline, parseTimelineItems } from './AgentActivityTimeline';
import type { MissionEvent } from '../../../shared/mission-events';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// A lista é o @legendapp/list REAL. O mock só embrulha o componente para
// registrar as props que a timeline passa; quem monta, mede, recicla e rola as
// linhas é a biblioteca.
const legendRecorder = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('@legendapp/list/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@legendapp/list/react')>();
  const React = await import('react');
  const RealLegendList = actual.LegendList as unknown as React.ComponentType<Record<string, unknown>>;
  function RecordingLegendList(props: Record<string, unknown>) {
    legendRecorder.props.push(props);
    return React.createElement(RealLegendList, props);
  }
  return { ...actual, LegendList: RecordingLegendList };
});

function lastLegendProps(): Record<string, unknown> {
  return legendRecorder.props[legendRecorder.props.length - 1];
}

// ---------------------------------------------------------------------------
// Layout falso: o jsdom não faz layout. A lista mede 480 px de altura, cada
// card fechado 56 px e um card aberto +200 px; scrollTop/scrollTo/scrollBy e o
// ResizeObserver se comportam como no navegador (instantâneo).
// ---------------------------------------------------------------------------
const VIEWPORT = 480;
const WIDTH = 360;
const ROW = 56;
const DETAIL = 200;

function isList(el: Element): boolean {
  return el.classList?.contains('agent-timeline__list') ?? false;
}

function fakeRect(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: WIDTH,
    height,
    right: WIDTH,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect;
}

function rectFor(el: Element): DOMRect {
  if (isList(el)) return fakeRect(VIEWPORT);
  if (!el.closest('.agent-timeline__list')) return fakeRect(0);
  // Um contêiner de linha do Legend envolve exatamente um item.
  const isRow =
    el.classList.contains('agent-timeline__item') ||
    el.querySelectorAll('.agent-timeline__item').length === 1;
  if (!isRow) return fakeRect(0);
  return fakeRect(ROW + (el.querySelector('.agent-timeline__pre') ? DETAIL : 0));
}

function contentHeight(list: Element): number {
  const content = list.firstElementChild as HTMLElement | null;
  if (!content) return 0;
  let height = 0;
  for (const child of Array.from(content.children) as HTMLElement[]) {
    height = Math.max(height, Number.parseFloat(child.style.height) || 0);
  }
  return height + (Number.parseFloat(content.style.paddingBottom) || 0);
}

function maxScrollTop(list: Element): number {
  return Math.max(0, contentHeight(list) - VIEWPORT);
}

const scrollTops = new WeakMap<Element, number>();

function writeScrollTop(el: Element, top: number) {
  const list = isList(el) ? el : null;
  const clamped = list ? Math.max(0, Math.min(top, maxScrollTop(list))) : 0;
  scrollTops.set(el, clamped);
  el.dispatchEvent(new Event('scroll'));
}

class FakeResizeObserver {
  static readonly instances = new Set<FakeResizeObserver>();
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    FakeResizeObserver.instances.delete(this);
  }

  static flush() {
    for (const observer of FakeResizeObserver.instances) {
      const entries = Array.from(observer.targets)
        .filter((target) => target.isConnected)
        .map((target) => {
          const rect = target.getBoundingClientRect();
          return {
            target,
            contentRect: rect,
            borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
            contentBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry;
        });
      if (entries.length > 0) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }
}

const restoreLayout: Array<() => void> = [];

function overrideProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restoreLayout.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as Record<string, unknown>)[key];
  });
}

beforeAll(() => {
  overrideProperty(globalThis, 'ResizeObserver', { value: FakeResizeObserver, writable: true });
  overrideProperty(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      return rectFor(this);
    },
  });
  overrideProperty(Element.prototype, 'clientHeight', {
    get(this: Element) {
      return isList(this) ? VIEWPORT : 0;
    },
  });
  overrideProperty(Element.prototype, 'clientWidth', {
    get(this: Element) {
      return isList(this) ? WIDTH : 0;
    },
  });
  overrideProperty(Element.prototype, 'scrollHeight', {
    get(this: Element) {
      if (isList(this)) return Math.max(VIEWPORT, contentHeight(this));
      if (this.parentElement && isList(this.parentElement)) return contentHeight(this.parentElement);
      return 0;
    },
  });
  overrideProperty(Element.prototype, 'scrollTop', {
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      writeScrollTop(this, value);
    },
  });
  overrideProperty(Element.prototype, 'scrollTo', {
    value(this: Element, options?: ScrollToOptions | number, y?: number) {
      const top = typeof options === 'object' ? options.top : y;
      if (typeof top === 'number') writeScrollTop(this, top);
    },
  });
  overrideProperty(Element.prototype, 'scrollBy', {
    value(this: Element, options?: ScrollToOptions | number, y?: number) {
      const delta = typeof options === 'object' ? options.top : y;
      if (typeof delta === 'number') writeScrollTop(this, (scrollTops.get(this) ?? 0) + delta);
    },
  });
});

afterAll(() => {
  for (const restore of restoreLayout.splice(0).reverse()) restore();
});

// ---------------------------------------------------------------------------

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

function renderUpdatable(node: ReactNode): {
  host: HTMLElement;
  rerender: (next: ReactNode) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return { host, rerender: (next) => act(() => root.render(next)) };
}

/** Deixa os frames do Legend (rAF) e os timers correrem dentro do act. */
async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function listOf(host: HTMLElement): HTMLElement {
  const list = host.querySelector<HTMLElement>('.agent-timeline__list');
  if (!list) throw new Error('lista virtualizada não montou');
  return list;
}

async function userScrollTo(list: HTMLElement, top: number): Promise<void> {
  act(() => {
    list.scrollTop = top;
  });
  await settle();
}

function renderedSequences(host: HTMLElement): number[] {
  return Array.from(host.querySelectorAll('.agent-timeline__sequence')).map((node) =>
    Number(node.textContent?.replace('#', '')),
  );
}

function cardFor(host: HTMLElement, sequence: number): HTMLElement {
  const card = Array.from(host.querySelectorAll<HTMLElement>('.agent-timeline__card')).find(
    (node) => node.querySelector('.agent-timeline__sequence')?.textContent === `#${sequence}`,
  );
  if (!card) throw new Error(`card #${sequence} não está montado`);
  return card;
}

/** Posição da linha no conteúdo virtual (o Legend posiciona o contêiner com `top`). */
function rowTop(host: HTMLElement, sequence: number): number {
  for (let el: HTMLElement | null = cardFor(host, sequence); el && !isList(el); el = el.parentElement) {
    if (el.style.top) return Number.parseFloat(el.style.top);
  }
  throw new Error(`card #${sequence} sem contêiner posicionado`);
}

beforeEach(() => {
  legendRecorder.props.length = 0;
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

const sampleEvents: MissionEvent[] = [
  {
    id: 'evt-1',
    sequence: 1,
    missionId: 'm-1',
    runId: 'r-1',
    origin: 'main',
    deliveryStatus: 'delivered',
    type: 'observer.turn_started',
    occurredAt: 1000,
    payload: { turnSequence: 1 },
    idempotencyKey: 'idemp-1',
  },
  {
    id: 'evt-2',
    sequence: 2,
    missionId: 'm-1',
    runId: 'r-1',
    origin: 'mcp',
    deliveryStatus: 'delivered',
    type: 'observer.tool_call',
    occurredAt: 1100,
    payload: { toolName: 'bash', command: 'npm test' },
    idempotencyKey: 'idemp-2',
  },
  {
    id: 'evt-3',
    sequence: 3,
    missionId: 'm-1',
    runId: 'r-1',
    origin: 'mcp',
    deliveryStatus: 'delivered',
    type: 'observer.tool_result',
    occurredAt: 1200,
    payload: { toolName: 'bash', ok: true, output: '18 tests passed' },
    idempotencyKey: 'idemp-3',
  },
  {
    id: 'evt-4',
    sequence: 4,
    missionId: 'm-1',
    runId: 'r-1',
    origin: 'main',
    deliveryStatus: 'delivered',
    type: 'agent.needs_input',
    occurredAt: 1300,
    payload: { prompt: 'Deseja prosseguir com o deploy?' },
    idempotencyKey: 'idemp-4',
  },
];

function makeEvents(missionId: string, count: number): MissionEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${missionId}-evt-${i}`,
    sequence: i + 1,
    missionId,
    runId: `r-${Math.floor(i / 10)}`,
    origin: 'mcp' as const,
    deliveryStatus: 'delivered' as const,
    type: 'observer.tool_result' as const,
    occurredAt: 1000 + i,
    payload: { toolName: 'bash', ok: true, output: `saída ${i}` },
    idempotencyKey: `${missionId}-idemp-${i}`,
  }));
}

describe('AgentActivityTimeline', () => {
  it('parses tool calls into structured models with correct kinds', () => {
    const items = parseTimelineItems(sampleEvents, 'm-1');
    expect(items).toHaveLength(4);

    expect(items[0].kind).toBe('generic');
    expect(items[0].title).toBe('Etapa 1');

    expect(items[1].kind).toBe('shell');
    expect(items[1].title).toBe('Shell');
    expect(items[1].subtitle).toBe('npm test');

    expect(items[2].kind).toBe('shell');
    expect(items[2].status).toBe('completed');
    expect(items[2].detail).toBe('18 tests passed');

    expect(items[3].category).toBe('decision');
    expect(items[3].subtitle).toBe('Deseja prosseguir com o deploy?');
  });

  it('renders timeline cards and allows filtering by category', () => {
    const host = render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);

    expect(host.querySelectorAll('.agent-timeline__item')).toHaveLength(4);
    expect(host.textContent).toContain('Shell');
    expect(host.textContent).toContain('npm test');

    // Click on Ferramentas filter tab
    const toolsTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Ferramentas'),
    );
    expect(toolsTab).toBeDefined();

    act(() => toolsTab!.click());

    // Should only show the 2 tool items
    expect(host.querySelectorAll('.agent-timeline__item')).toHaveLength(2);
  });

  it('expands detail preformatted block when clicking a card with output', () => {
    const host = render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);

    const resultCard = Array.from(host.querySelectorAll('.agent-timeline__card')).find(
      (card) => card.textContent?.includes('18 tests passed') || card.textContent?.includes('Concluída com sucesso'),
    );
    expect(resultCard).toBeDefined();

    // Not expanded yet
    expect(host.querySelector('.agent-timeline__pre')).toBeNull();

    // Click to expand
    act(() => {
      (resultCard as HTMLElement).click();
    });

    const pre = host.querySelector('.agent-timeline__pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('18 tests passed');
  });

  it('expands detail preformatted block when pressing Enter on focused card', () => {
    const host = render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);

    const resultCard = Array.from(host.querySelectorAll('.agent-timeline__card')).find(
      (card) => card.textContent?.includes('18 tests passed') || card.textContent?.includes('Concluída com sucesso'),
    ) as HTMLElement;
    expect(resultCard).toBeDefined();

    expect(host.querySelector('.agent-timeline__pre')).toBeNull();

    // Trigger Enter keydown
    act(() => {
      resultCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const pre = host.querySelector('.agent-timeline__pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('18 tests passed');
  });

  it('virtualiza 10 mil eventos com DOM limitado e abre no topo, como antes', async () => {
    const host = render(<AgentActivityTimeline events={makeEvents('m-1', 10_000)} missionId="m-1" />);
    await settle();

    const list = listOf(host);
    const sequences = renderedSequences(host);
    // Só a janela visível + buffer do Legend vira DOM (480 px / 56 px ≈ 9 linhas).
    expect(sequences.length).toBeGreaterThan(5);
    expect(sequences.length).toBeLessThan(60);
    expect(host.querySelectorAll('.agent-timeline__item').length).toBe(sequences.length);
    // Abre no topo: o primeiro evento está montado, o último não, e nada rolou.
    expect(sequences).toContain(1);
    expect(sequences).not.toContain(10_000);
    expect(list.scrollTop).toBe(0);
    // O conteúdo virtual tem a altura dos 10 mil cards.
    expect(contentHeight(list)).toBe(10_000 * ROW);
  });

  it('segue o stream só se já estava no fim', async () => {
    const { host, rerender } = renderUpdatable(
      <AgentActivityTimeline events={makeEvents('m-1', 30)} missionId="m-1" />,
    );
    await settle();
    const list = listOf(host);
    expect(list.scrollTop).toBe(0);

    // No topo: evento novo não puxa a lista.
    rerender(<AgentActivityTimeline events={makeEvents('m-1', 31)} missionId="m-1" />);
    await settle();
    expect(list.scrollTop).toBe(0);

    // O operador rola até o fim: o próximo evento mantém a lista no fim.
    await userScrollTo(list, maxScrollTop(list));
    rerender(<AgentActivityTimeline events={makeEvents('m-1', 32)} missionId="m-1" />);
    await settle();
    expect(list.scrollTop).toBe(32 * ROW - VIEWPORT);
    expect(renderedSequences(host)).toContain(32);

    // Rolou duas linhas para cima (bem menos que uma tela): o stream para de
    // puxar. Um threshold de "uma tela" ainda seguiria aqui.
    const upTwoRows = maxScrollTop(list) - 2 * ROW;
    await userScrollTo(list, upTwoRows);
    rerender(<AgentActivityTimeline events={makeEvents('m-1', 33)} missionId="m-1" />);
    await settle();
    expect(list.scrollTop).toBe(upTwoRows);
  });

  it('expansão de um card acima da viewport conserva o conteúdo visível', async () => {
    const host = render(<AgentActivityTimeline events={makeEvents('m-1', 30)} missionId="m-1" />);
    await settle();
    const list = listOf(host);
    await userScrollTo(list, 1000);

    // #15 ocupa 784–840 px: inteiro acima da viewport (que começa em 1000),
    // mas montado no buffer do Legend. #20 (1064 px) está na tela.
    const visibleOffsetBefore = rowTop(host, 20) - list.scrollTop;
    expect(rowTop(host, 15) + ROW).toBeLessThanOrEqual(list.scrollTop);

    act(() => {
      cardFor(host, 15).click();
      FakeResizeObserver.flush();
    });
    await settle();

    expect(host.querySelector('.agent-timeline__pre')?.textContent).toBe('saída 14');
    expect(contentHeight(list)).toBeGreaterThanOrEqual(30 * ROW + DETAIL);
    // O card cresceu 200 px acima: o scroll anda junto e o que estava na tela
    // fica parado no mesmo lugar da viewport.
    expect(list.scrollTop).toBeGreaterThanOrEqual(1000 + DETAIL);
    expect(rowTop(host, 20) - list.scrollTop).toBeCloseTo(visibleOffsetBefore, 0);
  });

  it('abrir um card no fim não puxa a lista: o follow fica suspenso até a linha assentar', async () => {
    const host = render(<AgentActivityTimeline events={makeEvents('m-1', 30)} missionId="m-1" />);
    await settle();
    const list = listOf(host);
    const end = maxScrollTop(list);
    await userScrollTo(list, end);
    expect(lastLegendProps().maintainScrollAtEnd).toEqual({ animated: true });

    act(() => {
      cardFor(host, 29).click();
      FakeResizeObserver.flush();
    });
    // Logo após o clique o follow está desligado…
    expect(lastLegendProps().maintainScrollAtEnd).toBe(false);
    await settle();

    // …e volta depois de dois frames, sem ter puxado o card clicado para cima.
    expect(lastLegendProps().maintainScrollAtEnd).toEqual({ animated: true });
    expect(contentHeight(list)).toBe(30 * ROW + DETAIL);
    expect(list.scrollTop).toBe(end);
  });

  it('troca de filtro ou de missão remonta a lista sem reaproveitar âncora', async () => {
    const { host, rerender } = renderUpdatable(
      <AgentActivityTimeline events={makeEvents('m-1', 30)} missionId="m-1" />,
    );
    await settle();
    const allList = listOf(host);
    await userScrollTo(allList, 1000);
    act(() => cardFor(host, 20).click());
    await settle();

    const tab = (label: string) =>
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!;

    act(() => tab('Ferramentas').click());
    await settle();
    const toolsList = listOf(host);
    expect(toolsList).not.toBe(allList);
    expect(toolsList.scrollTop).toBe(0);
    expect(renderedSequences(host)).toContain(1);

    // Voltar ao filtro anterior também não restaura o offset: abre no topo.
    act(() => tab('Todas').click());
    await settle();
    const allAgain = listOf(host);
    expect(allAgain).not.toBe(allList);
    expect(allAgain.scrollTop).toBe(0);

    // A expansão é estado do componente e sobrevive ao filtro (como antes).
    await userScrollTo(allAgain, 1000);
    expect(cardFor(host, 20).getAttribute('aria-expanded')).toBe('true');

    rerender(<AgentActivityTimeline events={makeEvents('m-2', 30)} missionId="m-2" />);
    await settle();
    const missionList = listOf(host);
    expect(missionList).not.toBe(allAgain);
    expect(missionList.scrollTop).toBe(0);
    expect(renderedSequences(host)).toContain(1);
  });

  it('disables animated follow under prefers-reduced-motion', () => {
    const previous = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);
      expect(lastLegendProps().maintainScrollAtEnd).toEqual({ animated: false });
    } finally {
      if (previous === undefined) {
        // @ts-expect-error jsdom has no matchMedia by default
        delete window.matchMedia;
      } else {
        window.matchMedia = previous;
      }
    }
  });
});
