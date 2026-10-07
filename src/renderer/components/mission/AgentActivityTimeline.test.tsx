/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActivityTimeline, parseTimelineItems } from './AgentActivityTimeline';
import { clearTimelinePositions } from '../../lib/activity-timeline-scroll';
import type { MissionEvent } from '../../../shared/mission-events';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// A virtualização real é garantia da biblioteca; aqui um stub com janela fixa
// ocupa o lugar dela (mesma abordagem do upstream em MessagesTimeline.test).
const legendCalls: { props: Record<string, unknown>; data: readonly unknown[] }[] = [];

vi.mock('@legendapp/list/react', () => ({
  LegendList: (props: {
    data?: readonly { id?: unknown }[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    [key: string]: unknown;
  }) => {
    const { data = [], renderItem, ...rest } = props;
    legendCalls.push({ props: rest as Record<string, unknown>, data });
    const window = data.slice(0, 40);
    return (
      <div className="agent-timeline__list-stub">
        {window.map((item, index) => (
          <div key={String(item.id ?? index)}>
            {renderItem?.({ item, index })}
          </div>
        ))}
      </div>
    );
  },
}));

function lastLegendProps(): Record<string, unknown> {
  return legendCalls[legendCalls.length - 1].props;
}

function lastLegendData(): readonly unknown[] {
  return legendCalls[legendCalls.length - 1].data;
}

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
  return {
    host,
    rerender: (next: ReactNode) => {
      act(() => root.render(next));
    },
  };
}

beforeEach(() => {
  legendCalls.length = 0;
  clearTimelinePositions();
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

  it('delegates 10k events to the virtualized list with bounded DOM', () => {
    const events = makeEvents('m-1', 10_000);
    const host = render(<AgentActivityTimeline events={events} missionId="m-1" />);

    // Full dataset reaches the list…
    expect(lastLegendData()).toHaveLength(10_000);

    // …with unique keys for every row…
    const keyExtractor = lastLegendProps().keyExtractor as (item: unknown) => string;
    const keys = new Set((lastLegendData() as unknown[]).map((item) => keyExtractor(item)));
    expect(keys.size).toBe(10_000);

    // …but only the window mounts nodes.
    const mounted = host.querySelectorAll('.agent-timeline__item').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(10_000);
  });

  it('follows the stream only while already at the end', () => {
    const { host, rerender } = renderUpdatable(
      <AgentActivityTimeline events={makeEvents('m-1', 3)} missionId="m-1" />,
    );
    expect(host.querySelectorAll('.agent-timeline__item').length).toBeGreaterThan(0);

    // Starts pinned: follow enabled.
    expect(lastLegendProps().maintainScrollAtEnd).not.toBe(false);

    const onScroll = lastLegendProps().onScroll as (e: unknown) => void;

    // User scrolls up: follow turns off and stays off as items stream in.
    act(() => {
      onScroll({ currentTarget: { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 } });
    });
    rerender(<AgentActivityTimeline events={makeEvents('m-1', 4)} missionId="m-1" />);
    expect(lastLegendProps().maintainScrollAtEnd).toBe(false);

    // Back at the live edge: follow re-arms.
    act(() => {
      onScroll({ currentTarget: { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 } });
    });
    expect(lastLegendProps().maintainScrollAtEnd).not.toBe(false);
  });

  it('keeps position anchoring enabled so expansion above preserves scroll', () => {
    render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);
    expect(lastLegendProps().maintainVisibleContentPosition).not.toBe(false);
  });

  it('starts at the end of the timeline', () => {
    render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);
    expect(lastLegendProps().initialScrollIndex).toBe(lastLegendData().length - 1);
  });

  it('does not reuse anchors across filter or mission switches', () => {
    const host = render(<AgentActivityTimeline events={sampleEvents} missionId="m-1" />);

    // Expand one card, then switch filter: expansion and anchor reset.
    const resultCard = Array.from(host.querySelectorAll('.agent-timeline__card')).find(
      (card) => card.textContent?.includes('Concluída com sucesso'),
    ) as HTMLElement;
    act(() => resultCard.click());
    expect(host.querySelector('.agent-timeline__pre')).not.toBeNull();

    const toolsTab = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Ferramentas'),
    );
    act(() => toolsTab!.click());

    expect(host.querySelector('.agent-timeline__pre')).toBeNull();
    const extra = String(lastLegendProps().extraData ?? '');
    expect(extra.startsWith('m-1::tools:')).toBe(true);
    expect(lastLegendProps().maintainScrollAtEnd).not.toBe(false);

    // Switch mission: new scope, no reused anchor.
    render(<AgentActivityTimeline events={makeEvents('m-2', 2)} missionId="m-2" />);
    const extraMission = String(lastLegendProps().extraData ?? '');
    expect(extraMission.startsWith('m-2::all:')).toBe(true);
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
