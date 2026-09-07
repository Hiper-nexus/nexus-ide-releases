/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentActivityTimeline, parseTimelineItems } from './AgentActivityTimeline';
import type { MissionEvent } from '../../../shared/mission-events';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

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
});
