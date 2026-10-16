/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PaneActivityStrip,
  resetMissionPanesCacheForTests,
} from './PaneActivityStrip';
import { useOrchStore } from '../state/orch-store';
import type { MissionPaneSpec } from '../../shared/orch-types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const listMissionPanes = vi.fn<(missionId: string) => Promise<MissionPaneSpec[]>>();

function spec(paneId: string, lastLine: string): MissionPaneSpec {
  return {
    id: `spec-${paneId}`,
    missionId: 'mission-1',
    adapterId: 'codex',
    title: `Task ${paneId}`,
    role: 'worker',
    paneId,
    createdAt: 0,
    activity: { title: `Task ${paneId}`, lastLine },
  } as MissionPaneSpec;
}

const roots: Root[] = [];

/** Monta todos os panes num único act para os efeitos correrem juntos —
 *  exatamente o cenário de N strips da mesma missão disparando na mesma
 *  rodada. */
async function mountAll(...paneIds: string[]): Promise<HTMLElement[]> {
  const hosts = paneIds.map(() => {
    const host = document.createElement('div');
    document.body.append(host);
    return host;
  });
  await act(async () => {
    paneIds.forEach((paneId, i) => {
      const root = createRoot(hosts[i]);
      roots.push(root);
      root.render(<PaneActivityStrip paneId={paneId} />);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return hosts;
}

beforeEach(() => {
  resetMissionPanesCacheForTests();
  listMissionPanes.mockReset();
  (window as typeof window & { nexus: unknown }).nexus = {
    orch: { listMissionPanes },
  } as unknown as typeof window.nexus;
  useOrchStore.setState({
    paneMissions: {},
    missionSummaries: [],
  } as never);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('PaneActivityStrip', () => {
  it('renders the pane activity line from the mission specs', async () => {
    useOrchStore.setState({
      paneMissions: { 'pane-a': 'mission-1' },
      missionSummaries: [],
    } as never);
    listMissionPanes.mockResolvedValue([spec('pane-a', 'rodando testes')]);
    const [host] = await mountAll('pane-a');
    expect(host.textContent).toContain('rodando testes');
    expect(listMissionPanes).toHaveBeenCalledTimes(1);
    expect(listMissionPanes).toHaveBeenCalledWith('mission-1');
  });

  it('coalesces concurrent refreshes of panes in the same mission into one IPC', async () => {
    useOrchStore.setState({
      paneMissions: {
        'pane-a': 'mission-1',
        'pane-b': 'mission-1',
        'pane-c': 'mission-1',
      },
      missionSummaries: [],
    } as never);
    listMissionPanes.mockResolvedValue([
      spec('pane-a', 'linha A'),
      spec('pane-b', 'linha B'),
      spec('pane-c', 'linha C'),
    ]);
    const [a, b, c] = await mountAll('pane-a', 'pane-b', 'pane-c');
    expect(listMissionPanes).toHaveBeenCalledTimes(1);
    expect(a.textContent).toContain('linha A');
    expect(b.textContent).toContain('linha B');
    expect(c.textContent).toContain('linha C');
  });

  it('does not share the flight across different missions', async () => {
    useOrchStore.setState({
      paneMissions: {
        'pane-a': 'mission-1',
        'pane-z': 'mission-2',
      },
      missionSummaries: [],
    } as never);
    listMissionPanes.mockImplementation(async (missionId: string) => [
      {
        ...spec(missionId === 'mission-1' ? 'pane-a' : 'pane-z', `viva ${missionId}`),
        missionId,
      } as MissionPaneSpec,
    ]);
    const [a, z] = await mountAll('pane-a', 'pane-z');
    expect(listMissionPanes).toHaveBeenCalledTimes(2);
    expect(a.textContent).toContain('viva mission-1');
    expect(z.textContent).toContain('viva mission-2');
  });

  it('stays silent when the pane is not in a mission and never calls the IPC', async () => {
    const [host] = await mountAll('pane-solo');
    expect(host.textContent).toBe('');
    expect(listMissionPanes).not.toHaveBeenCalled();
  });
});
