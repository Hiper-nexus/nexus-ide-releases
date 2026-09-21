/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetPrefs } from '../../../shared/pet-types';
import type * as PetHatchFlowModule from '../../pet/pet-hatch-flow';
import { PetSection } from './PetSection';

const { preparePetHatchMission } = vi.hoisted(() => ({
  preparePetHatchMission: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../pet/pet-hatch-flow', async (importOriginal) => ({
  ...(await importOriginal<typeof PetHatchFlowModule>()),
  preparePetHatchMission,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PREFS: PetPrefs = {
  enabled: true,
  sleeping: false,
  preset: 'operator',
  customGrid: null,
  sheet: null,
  position: null,
  solidBackground: false,
  roam: false,
  hudTicker: false,
};

const IMAGE_PATH = '/Users/x/Pictures/Meu Gato.png';
const installedApply = vi.fn(async () => ({
  ok: true,
  name: 'Codex Companion',
  prefs: { ...PREFS, preset: 'sheet' as const },
}));

function installPetApi() {
  (window as unknown as { nexus: { pet: unknown } }).nexus = {
    pet: {
      getPrefs: () => Promise.resolve(PREFS),
      setPrefs: (patch: Partial<PetPrefs>) =>
        Promise.resolve({ ...PREFS, ...patch }),
      onPrefsChanged: () => () => {},
      pickImage: () => Promise.resolve({ ok: true, path: IMAGE_PATH }),
      installedList: () =>
        Promise.resolve({
          ok: true,
          items: [
            {
              id: 'generated-pet',
              slug: 'generated-pet',
              label: 'Codex Companion',
              note: 'Pet criado pelo Pet Studio',
            },
          ],
        }),
      installedPreview: () => Promise.resolve({ ok: false }),
      installedApply,
    },
  };
}

describe('PetSection — Criar pet com IA (hatch)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    preparePetHatchMission.mockClear();
    installedApply.mockClear();
    installPetApi();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as { nexus?: unknown }).nexus;
  });

  it('keeps the local pet library visible when the desktop mascot is disabled', async () => {
    window.nexus.pet.getPrefs = async () => ({ ...PREFS, enabled: false });
    await act(async () => root.render(<PetSection />));
    expect(host.textContent).toContain('Meus pets (1)');
    expect(host.textContent).toContain('Codex Companion');
    expect(installedApply).not.toHaveBeenCalled();
  });

  it('prepares a visible Review without claiming an early start', async () => {
    await act(async () => {
      root.render(<PetSection />);
    });

    const button = [...host.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Criar pet com IA'),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(preparePetHatchMission).toHaveBeenCalledWith(IMAGE_PATH);
    expect(host.textContent).toMatch(/revisão.*pronta/i);
    expect(host.textContent).not.toMatch(
      /criação.*iniciada|missão já existe|iniciando a missão/i,
    );
  });

  it('lista pets gerados separadamente e só troca o atual após clique', async () => {
    await act(async () => {
      root.render(<PetSection />);
    });

    expect(host.textContent).toContain('Meus pets (1)');
    expect(host.textContent).toContain('Codex Companion');
    expect(installedApply).not.toHaveBeenCalled();

    const generated = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Codex Companion'),
    );
    expect(generated).toBeTruthy();
    await act(async () => {
      generated!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(installedApply).toHaveBeenCalledWith('generated-pet');
  });
});
