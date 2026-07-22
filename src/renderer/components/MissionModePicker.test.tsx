/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionModePicker } from './MissionModePicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(squadCount = 2): {
  host: HTMLDivElement;
  root: Root;
  onChooseMode: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChooseMode = vi.fn();
  act(() => {
    root.render(
      <MissionModePicker
        selectedMode={null}
        squadCount={squadCount}
        hasPlanningSquad
        onChooseMode={onChooseMode}
        onChoosePlanning={vi.fn()}
      />,
    );
  });
  return { host, root, onChooseMode };
}

describe('MissionModePicker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('leads with the recommended autopilot path', () => {
    const { host, root } = mount();
    const cards = [...host.querySelectorAll<HTMLButtonElement>('.wizard__mode')];

    expect(cards[0]?.textContent).toContain('Piloto automático');
    expect(cards[0]?.textContent).toContain('Recomendado');
    expect(cards[1]?.textContent).toContain('Modo Livre');
    expect(cards[1]?.textContent).not.toContain('Recomendado');
    act(() => root.unmount());
  });

  it('routes autopilot explicitly to the agentic engine', () => {
    const { host, root, onChooseMode } = mount();
    const autopilot = host.querySelector<HTMLButtonElement>('.wizard__mode');

    act(() => autopilot?.click());
    expect(onChooseMode).toHaveBeenCalledWith('agentic');
    act(() => root.unmount());
  });

  it('keeps the saved-squad path visibly unavailable when none exist', () => {
    const { host, root } = mount(0);
    const squad = [...host.querySelectorAll<HTMLButtonElement>('.wizard__mode')]
      .find((button) => button.textContent?.includes('Modo Squad'));

    expect(squad?.disabled).toBe(true);
    expect(squad?.textContent).toContain('nenhum squad salvo');
    act(() => root.unmount());
  });
});
