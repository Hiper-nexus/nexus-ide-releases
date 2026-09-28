/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../../shared/orch-types';
import { NEXUS_LEFTOVER_PARKED_MARKER } from '../../../shared/mission-leftover-isolation';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { MissionTerminalRecovery } from './MissionTerminalRecovery';

const reopen = vi.hoisted(() => vi.fn());
vi.mock('../../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: reopen,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const mission: Mission = {
  id: 'from-pane',
  title: 'Minha feature',
  status: 'blocked',
  intentState: 'blocked_user',
  description: NEXUS_LEFTOVER_PARKED_MARKER,
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 2,
};
function render(overrides: Partial<Mission> = {}) {
  useOrchStore.setState({ missions: [{ ...mission, ...overrides }] });
  act(() => root.render(<MissionTerminalRecovery missionId={mission.id} />));
}
function button() {
  return host.querySelector('button')!;
}
beforeEach(() => {
  reopen.mockReset().mockResolvedValue({ ok: true, panes: 1 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useOrchStore.setState({ missions: [] });
});
describe('mission terminal recovery', () => {
  it('parked + Pane mission resumes explicitly, without a squad or automatic spawn', async () => {
    render();
    expect(host.textContent).toContain('dormindo');
    expect(button().textContent).toBe('Retomar missão');
    expect(reopen).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(reopen).toHaveBeenCalledExactlyOnceWith(mission);
  });
  it('prevents duplicate requests and exposes failures with a working retry', async () => {
    let finish!: (r: { ok: boolean; error: string }) => void;
    reopen.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    render();
    act(() => {
      button().click();
      button().click();
    });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    await act(async () =>
      finish({ ok: false, error: 'A CLI não confirmou a sessão.' }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'A CLI não confirmou',
    );
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('reports a rejected IPC instead of leaving the action stuck', async () => {
    reopen.mockRejectedValue(new Error('Conexão interrompida'));
    render();
    await act(async () => button().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Conexão interrompida',
    );
    expect(button().disabled).toBe(false);
  });
  it('takes a real pending question to the board without resuming work', async () => {
    render({ description: 'Qual opção você prefere?' });
    expect(button().textContent).toBe('Responder no Quadro');
    await act(async () => button().click());
    expect(reopen).not.toHaveBeenCalled();
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'mission',
      missionId: mission.id,
    });
  });
  it.each(['done', 'failed'] as const)(
    'does not restart a %s mission just by opening its terminals',
    async (status) => {
      render({ status });
      expect(host.textContent).not.toContain('dormindo');
      expect(button().textContent).toBe('Abrir Quadro');
      await act(async () => button().click());
      expect(reopen).not.toHaveBeenCalled();
    },
  );
  it('a running mission without its terminal reuses the canonical reopen path', async () => {
    render({ status: 'running', intentState: 'executing', description: '' });
    expect(button().textContent).toBe('Reabrir terminal');
    await act(async () => button().click());
    expect(reopen).toHaveBeenCalledTimes(1);
  });
});
