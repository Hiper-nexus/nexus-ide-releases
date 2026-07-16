/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import { SquadEditor } from './SquadEditor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const builtin: Squad = {
  id: 'nexus-full',
  name: 'Full-Stack',
  createdAt: '1',
  builtin: true,
  orchestratorInstructions: 'orquestre',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', model: 'claude-sonnet-5', allowedTools: null },
  ],
};

function stubNexus(saveSquad: (squad: Squad) => Promise<{ ok: boolean; error?: string }>) {
  // jsdom já provê window.crypto.randomUUID; só injetamos a ponte nexus.
  (window as unknown as { nexus: unknown }).nexus = {
    adapters: { list: vi.fn(async () => []) },
    orch: { saveSquad },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SquadEditor', () => {
  it('salvar um builtin envia uma CÓPIA (id novo, builtin=false) via saveSquad', async () => {
    const saveSquad = vi.fn(async (_squad: Squad) => ({ ok: true as const }));
    stubNexus(saveSquad);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <SquadEditor squad={builtin} onClose={vi.fn()} onSaved={vi.fn()} />,
      );
    });

    const saveBtn = [...document.body.querySelectorAll('button')].find((b) =>
      /criar cópia|salvar/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn.click();
    });

    expect(saveSquad).toHaveBeenCalledTimes(1);
    const payload = saveSquad.mock.calls[0]![0];
    expect(payload.builtin).toBe(false);
    expect(payload.id).not.toBe('nexus-full');
    expect(payload.name).toBe('Full-Stack');
    act(() => root.unmount());
  });
});
