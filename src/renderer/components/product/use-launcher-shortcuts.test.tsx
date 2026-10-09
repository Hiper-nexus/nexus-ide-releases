/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useLauncherShortcuts,
  type LauncherShortcutActions,
} from './use-launcher-shortcuts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(node: ReactNode): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function actions(): LauncherShortcutActions {
  return {
    pane: vi.fn(),
    mission: vi.fn(),
    workspace: vi.fn(),
    shell: vi.fn(),
    tasks: vi.fn(),
    memory: vi.fn(),
  };
}

function keydown(key: string, repeat: boolean): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('launcher shortcuts', () => {
  it('treats a repeated number key as one activation', () => {
    const run = actions();
    function Probe() {
      useLauncherShortcuts(true, run);
      return null;
    }
    render(<Probe />);
    act(() => {
      keydown('4', false);
      keydown('4', true);
      keydown('4', true);
      keydown('3', false);
      keydown('3', true);
    });
    expect(run.shell).toHaveBeenCalledTimes(1);
    expect(run.workspace).toHaveBeenCalledTimes(1);
    expect(run.pane).not.toHaveBeenCalled();
  });
});
