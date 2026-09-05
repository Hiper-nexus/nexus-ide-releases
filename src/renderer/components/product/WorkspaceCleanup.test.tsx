/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceCleanup } from './WorkspaceCleanup';
const mocks = vi.hoisted(() => ({
  workspace: { path: '/project', name: 'Projeto' },
  confirm: vi.fn(), close: vi.fn(), stop: vi.fn(), remove: vi.fn(), toast: vi.fn(),
}));
vi.mock('../../state/workspace-store', () => ({ useWorkspaceStore: Object.assign(
  (selector: (state: unknown) => unknown) => selector({ current: mocks.workspace }),
  { getState: () => ({ current: mocks.workspace }) },
) }));
vi.mock('../../state/layout-store', () => ({ useLayoutStore: { getState: () => ({ root: {}, close: mocks.close }) } }));
vi.mock('../../lib/split-tree', () => ({ listPanes: () => [{ id: 'a', missionId: 'mission-a' }, { id: 'b' }] }));
vi.mock('../../state/orch-store', () => ({ useOrchStore: { getState: () => ({ paneMissions: {} }) } }));
vi.mock('../../state/confirm-store', () => ({ askConfirm: mocks.confirm }));
vi.mock('../../state/toast-store', () => ({ useToastStore: { getState: () => ({ push: mocks.toast }) } }));
vi.mock('../../orch/close-mission-runtime', () => ({ closeMissionRuntimeAndPanes: mocks.stop }));
let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks(); mocks.workspace = { path: '/project', name: 'Projeto' };
  mocks.confirm.mockResolvedValue(true); mocks.stop.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ removed: true });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: {
    listMissions: vi.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]), removeMission: mocks.remove,
  } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<WorkspaceCleanup />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'nexus'); });
async function click(label: string) {
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
}
it('cancelling deletes nothing and asks only once for the whole batch', async () => {
  mocks.confirm.mockResolvedValue(false);
  await click('Apagar todas as missões');
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Apagar 2 missões?' }));
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('deletes every confirmed mission through main authority', async () => {
  await click('Apagar todas as missões');
  expect(mocks.remove.mock.calls).toEqual([['one'], ['two']]);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
});
it('aborts when the project changes while confirmation is open', async () => {
  mocks.confirm.mockImplementation(async () => { mocks.workspace = { path: '/other', name: 'Outro' }; return true; });
  await click('Apagar todas as missões');
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('keeps panes of a mission whose runtime could not be stopped', async () => {
  mocks.stop.mockResolvedValue({ ok: false, error: 'ocupado' });
  await click('Fechar todos os panes');
  expect(mocks.close.mock.calls).toEqual([['b', 'mission-runtime-close']]);
  expect(mocks.toast).toHaveBeenCalledWith('error', 'Limpeza parcial', expect.stringContaining('1 falharam'));
});
