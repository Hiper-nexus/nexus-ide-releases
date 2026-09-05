/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ModelReel } from './ModelReel';

it('explores with keyboard without changing the model until explicit selection', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  act(() => root.render(<ModelReel options={[
    { adapterId: 'claude', adapterLabel: 'Claude', model: 'Opus', ready: true },
    { adapterId: 'codex', adapterLabel: 'Codex', model: 'GPT', ready: false },
    { adapterId: 'kimi', adapterLabel: 'Kimi', model: 'K3', ready: true },
  ]} selected={{ adapterId: 'claude', model: 'Opus' }} onSelect={onSelect} />));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-model-option]');
  act(() => {
    buttons[0]!.focus();
    buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(document.activeElement).toBe(buttons[2]);
  expect(onSelect).not.toHaveBeenCalled();
  act(() => buttons[2]!.click());
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ model: 'K3' }));
  expect(host.querySelectorAll('[role="img"]')).toHaveLength(3);
  act(() => root.unmount());
  host.remove();
});
