/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import { MissionLaneBar, type MissionLaneBarProps } from './MissionLaneBar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

const SCOPES: readonly PaneScopeEntry[] = [
  {
    key: 'mission:m1',
    kind: 'mission',
    id: 'm1',
    title: 'Checkout com Stripe',
    paneCount: 4,
    state: 'running',
    orchestrator: { paneId: 'p1', title: 'Claude Opus 5.5' },
  },
  {
    key: 'mission:m2',
    kind: 'mission',
    id: 'm2',
    title: 'Auth multi-conta',
    paneCount: 2,
    state: 'done',
    orchestrator: null,
  },
];

function render(overrides: Partial<MissionLaneBarProps> = {}) {
  const props: MissionLaneBarProps = {
    scopes: SCOPES,
    activeScopeKey: 'mission:m1',
    onFocusScope: vi.fn(),
    pinnedA: null,
    pinnedB: null,
    onTogglePin: vi.fn(),
    onSwitchAB: vi.fn(),
    onNewMission: vi.fn(),
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(<MissionLaneBar {...props} />));
  return { host, props };
}

describe('MissionLaneBar', () => {
  it('shows the orchestrator name once, in the crest, and moves the state to the tooltip', () => {
    const { host } = render();
    const lane = host.querySelector('[data-scope-kind="mission"]')!;
    expect(lane.querySelector('.mission-lane__crest-name')?.textContent).toBe('Claude Opus 5.5');
    expect(lane.textContent?.match(/Claude Opus 5\.5/g)).toHaveLength(1);
    expect(lane.querySelector('.mission-lane__meta-text')).toBeNull();
    expect(lane.querySelector('.mission-lane__main')?.getAttribute('title')).toBe(
      'Checkout com Stripe — em curso',
    );
  });

  it('keeps the state text when the mission has no orchestrator', () => {
    const { host } = render();
    const lanes = host.querySelectorAll('[data-scope-kind="mission"]');
    expect(lanes[1]!.querySelector('.mission-lane__meta-text')?.textContent).toBe('concluída');
  });

  it('shows the A/B switch only with two distinct pins and routes clicks', () => {
    expect(render().host.querySelector('.mission-lane-bar__ab')).toBeNull();
    const { host, props } = render({ pinnedA: 'mission:m1', pinnedB: 'mission:m2' });
    const [a, b] = host.querySelectorAll<HTMLButtonElement>('.mission-lane-bar__ab-btn');
    expect(a!.getAttribute('aria-pressed')).toBe('true');
    act(() => b!.click());
    expect(props.onSwitchAB).toHaveBeenCalledWith('b');
  });
});
