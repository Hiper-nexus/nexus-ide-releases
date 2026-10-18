/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../../shared/orch-types';
import { NEXUS_LEFTOVER_PARKED_MARKER } from '../../../shared/mission-leftover-isolation';
import { MISSION_RUNTIME_CLOSED_MARKER } from '../../../shared/mission-recovery-policy';
import { useOrchStore } from '../../state/orch-store';
import { MissionInterruptedCard } from './MissionInterruptedCard';

const reopen = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
vi.mock('../../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: reopen,
  reportMissionReopen: report,
}));
vi.mock('../../lib/mission-attention-route', () => ({
  routeMissionAttention: vi.fn(),
}));
vi.mock('../../terminal/terminal-host', () => ({
  getPaneSessionId: vi.fn(() => null),
}));

const listMissionPanes = vi.fn();
(globalThis as Record<string, unknown>).window = globalThis;
Object.defineProperty(globalThis, 'nexus', {
  value: { orch: { listMissionPanes } },
  configurable: true,
});

(globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    title: 'Missão X',
    status: 'running',
    intentState: 'executing',
    description: '',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function seed(
  missionPatch: Partial<Mission> = {},
  reasonCode?: string,
  reasonLabel = 'x',
): void {
  useOrchStore.setState({
    missions: [mission(missionPatch)],
    missionSummaries: reasonCode
      ? [
          {
            id: 'm-1',
            title: 'Missão X',
            state: 'blocked_technical',
            stateReason: { code: reasonCode, label: reasonLabel },
            progress: { completed: 0, total: 0 },
            needsAttention: false,
            updatedAt: 2,
          },
        ]
      : [],
    squads: [],
  });
}

const SPECS = [
  {
    id: 'spec-1',
    missionId: 'm-1',
    adapterId: 'claude',
    title: 'Maestro',
    agentName: 'Maestro',
    role: 'orchestrator' as const,
    paneId: 'pane-1',
  },
  {
    id: 'spec-2',
    missionId: 'm-1',
    adapterId: 'codex',
    title: 'executor',
    agentName: 'executor',
    role: 'worker' as const,
    paneId: 'pane-2',
    model: 'gpt-5',
  },
];

async function render(props: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(<MissionInterruptedCard missionId="m-1" {...props} />),
  );
  // listMissionPanes resolve fora do act do render
  await act(async () => Promise.resolve());
}

beforeEach(() => {
  reopen.mockReset().mockResolvedValue({ ok: true, panes: 2, sessionIds: ['a', 'b'] });
  report.mockReset();
  listMissionPanes.mockReset().mockResolvedValue(SPECS);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useOrchStore.setState({ missions: [], missionSummaries: [], squads: [] });
});

describe('MissionInterruptedCard', () => {
  it('motivo civil para cada código de interrupção', async () => {
    seed({}, 'session-dead');
    await render();
    expect(host.textContent).toContain('O Nexus fechou com a missão em andamento');

    seed({}, 'session-sleeping');
    await render();
    expect(host.textContent).toContain('O Nexus fechou com a missão em andamento');

    seed({}, 'runtime-closed');
    await render();
    expect(host.textContent).toContain('Você encerrou a execução');

    seed({ description: NEXUS_LEFTOVER_PARKED_MARKER }, undefined);
    await render();
    expect(host.textContent).toContain('O Nexus fechou com a missão em andamento');

    seed({ description: MISSION_RUNTIME_CLOSED_MARKER, status: 'blocked', intentState: 'blocked_technical' }, undefined);
    await render();
    expect(host.textContent).toContain('Você encerrou a execução');
  });

  it('exatamente uma primária "Retomar missão" mais o link', async () => {
    seed({}, 'session-dead');
    await render();
    const primaries = host.querySelectorAll('.action-card--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toContain('Retomar missão');
    expect(host.textContent).toContain('Ver o que aconteceu');
  });

  it('lista quem volta via listMissionPanes', async () => {
    seed({}, 'session-dead');
    await render();
    expect(listMissionPanes).toHaveBeenCalledWith('m-1');
    expect(host.textContent).toContain('Maestro');
    expect(host.textContent).toContain('executor');
    expect(host.textContent).toContain('volta ao retomar');
  });

  it('Reabrindo → De volta e anuncia o resultado', async () => {
    seed({}, 'session-dead');
    let ready!: (paneId: string, sessionId: string | null) => void;
    reopen.mockImplementation((_m: unknown, opts: { onPaneReady: typeof ready }) => {
      ready = opts.onPaneReady;
      return Promise.resolve({ ok: true, panes: 2, sessionIds: ['a', 'b'] });
    });
    await render();
    const button = host.querySelector<HTMLButtonElement>('.action-card--primary')!;
    await act(async () => button.click());
    expect(reopen).toHaveBeenCalledTimes(1);
    act(() => ready('pane-1', 'sess-1'));
    expect(host.textContent).toContain('De volta');
    await act(async () => Promise.resolve());
    expect(report).toHaveBeenCalled();
  });

  it('caso parcial nomeia quem não voltou', async () => {
    seed({}, 'session-dead');
    reopen.mockResolvedValue({
      ok: true,
      panes: 2,
      sessionIds: ['a'],
      partialPanes: [
        { paneId: 'pane-2', title: 'executor', reason: 'x', action: 'y' },
      ],
    });
    await render();
    const button = host.querySelector<HTMLButtonElement>('.action-card--primary')!;
    await act(async () => button.click());
    expect(host.textContent).toContain('não confirmou a sessão');
  });

  it('nada renderizado com needsAnswer', async () => {
    seed({ status: 'blocked', intentState: 'blocked_user' }, 'open-question');
    await render();
    expect(host.querySelector('.mission-interrupted')).toBeNull();
    expect(host.textContent).not.toContain('Missão interrompida');
  });
});
