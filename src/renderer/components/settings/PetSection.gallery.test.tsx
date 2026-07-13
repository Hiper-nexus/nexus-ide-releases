/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHEET_DATA_URL_MAX,
  type PetPrefs,
} from '../../../shared/pet-types';
import { PetSection, preparePetSheetDataUrl } from './PetSection';

vi.mock('../../pet/SheetPetSprite', () => ({
  SheetPetSprite: ({ sheet }: { sheet: { rows: number } }) => (
    <span data-testid="gallery-sheet-preview">preview-{sheet.rows}</span>
  ),
}));
vi.mock('../OperatorSprite', () => ({
  OperatorSprite: () => <span>operator-preview</span>,
}));
vi.mock('../../pet/CustomPetSprite', () => ({
  CustomPetSprite: () => <span>custom-preview</span>,
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
};

const SHEET_DATA_URL = 'data:image/webp;base64,YQ==';

class GalleryImage {
  width = 1536;
  height = 1872;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('PetSection — galeria com preview', () => {
  let host: HTMLDivElement;
  let root: Root;
  const setPrefs = vi.fn(async (patch: Partial<PetPrefs>) => ({
    ...PREFS,
    ...patch,
  }));
  const galleryImport = vi.fn(async () => ({
    ok: true,
    name: 'Navi',
    dataUrl: SHEET_DATA_URL,
  }));

  beforeEach(() => {
    setPrefs.mockClear();
    galleryImport.mockClear();
    vi.stubGlobal('Image', GalleryImage);
    (window as unknown as { nexus: { pet: unknown } }).nexus = {
      pet: {
        getPrefs: () => Promise.resolve(PREFS),
        setPrefs,
        onPrefsChanged: () => () => {},
        galleryList: () =>
          Promise.resolve({
            ok: true,
            items: [{ slug: 'navi', label: 'Navi' }],
          }),
        galleryImport,
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as { nexus?: unknown }).nexus;
  });

  it('mostra um pet petdex 8×9 antes de aplicar e importa só após confirmação', async () => {
    await act(async () => {
      root.render(<PetSection />);
    });

    const galleryButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Ver galeria'),
    );
    expect(galleryButton).toBeTruthy();
    await act(async () => {
      galleryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const petButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Navi',
    );
    expect(petButton).toBeTruthy();
    await act(async () => {
      petButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('Pré-visualização');
    expect(host.textContent).toContain('preview-9');
    expect(setPrefs).not.toHaveBeenCalled();

    const importButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Importar este pet'),
    );
    expect(importButton).toBeTruthy();
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setPrefs).toHaveBeenCalledWith({
      sheet: { dataUrl: SHEET_DATA_URL, cols: 8, rows: 9 },
      preset: 'sheet',
    });
    expect(host.textContent).not.toContain('Pré-visualização');
    expect(host.textContent).not.toContain('Importar este pet');
  });

  it('reduz um asset remoto grande mantendo a malha petdex', async () => {
    const compact = 'data:image/webp;base64,Y29tcGFjdA==';
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(compact);

    const prepared = await preparePetSheetDataUrl(
      `data:image/webp;base64,${'A'.repeat(SHEET_DATA_URL_MAX)}`,
    );

    expect(prepared).toEqual({
      ok: true,
      sheet: { dataUrl: compact, cols: 8, rows: 9 },
    });
    expect(drawImage).toHaveBeenCalledOnce();
  });
});
