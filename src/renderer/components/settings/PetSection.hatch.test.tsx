/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetPrefs } from '../../../shared/pet-types';
import { PetSection } from './PetSection';
import { useMissionWizardStore } from '../../state/mission-wizard-store';
import { useSettingsStore } from '../../state/settings-store';

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
};

const IMAGE_PATH = '/Users/x/Pictures/Meu Gato.png';

function installPetApi() {
  (window as unknown as { nexus: { pet: unknown } }).nexus = {
    pet: {
      getPrefs: () => Promise.resolve(PREFS),
      setPrefs: (patch: Partial<PetPrefs>) =>
        Promise.resolve({ ...PREFS, ...patch }),
      onPrefsChanged: () => () => {},
      pickImage: () => Promise.resolve({ ok: true, path: IMAGE_PATH }),
    },
  };
}

describe('PetSection — Gerar pet com IA (hatch)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it('clicar no botão fecha o drawer e abre o wizard com a missão hatch', async () => {
    useSettingsStore.setState({ drawerOpen: true });
    useMissionWizardStore.setState({ open: false, agenticIntent: null });

    await act(async () => {
      root.render(<PetSection />);
    });

    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Gerar pet com IA'),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const wizard = useMissionWizardStore.getState();
    expect(wizard.open).toBe(true);
    expect(wizard.agenticIntent).toContain(IMAGE_PATH);
    expect(wizard.agenticIntent).toContain('hatch-pet');
    expect(wizard.agenticIntent).toContain('~/.codex/pets/meu-gato/');
    expect(useSettingsStore.getState().drawerOpen).toBe(false);
  });
});
