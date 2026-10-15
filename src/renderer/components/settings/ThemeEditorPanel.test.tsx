/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportedTheme } from '../../../shared/settings-types';
import { PALETTES } from '../../styles/ui-theme';
import { parseVsCodeThemeFile } from '../../styles/vscode-theme-import';
import { ThemeEditorPanel, slugify, toOpaqueHex } from './ThemeEditorPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('toOpaqueHex', () => {
  it('hex já opaco passa em minúsculo', () => {
    expect(toOpaqueHex('#FF4F8B')).toBe('#ff4f8b');
    expect(toOpaqueHex('#abc')).toBe('#aabbcc');
  });

  it('rgb opaco vira hex', () => {
    expect(toOpaqueHex('rgba(8, 7, 9, 1)')).toBe('#080709');
    expect(toOpaqueHex('rgb(255 255 255)')).toBe('#ffffff');
  });

  it('alfa se resolve SOBRE o base (borda 8% de branco sobre bg escuro)', () => {
    // rgb(255,255,255 / .08) sobre #080709 → ~#252427, nunca #ffffff
    const flat = toOpaqueHex('rgb(255 255 255 / 0.08)', '#080709');
    expect(flat).not.toBe('#ffffff');
    expect(flat).toMatch(/^#[0-9a-f]{6}$/);
    // bem mais próximo do fundo do que do branco
    const n = Number.parseInt(flat.slice(1), 16);
    expect(n).toBeLessThan(Number.parseInt('808080', 16));
  });

  it('desconhecido vira preto (nunca CSS arbitrário)', () => {
    expect(toOpaqueHex('url(evil)')).toBe('#000000');
    expect(toOpaqueHex('expression(alert(1))')).toBe('#000000');
  });
});

describe('slugify', () => {
  it('gera slug estável para id custom-*', () => {
    expect(slugify('Meu Tema')).toBe('meu-tema');
    expect(slugify('  Café!!!  ')).toBe('cafe');
    expect(slugify('---')).toBe('tema');
    expect(slugify('')).toBe('tema');
    // nunca deixa o regex do schema quebrar
    expect(slugify('Tema/..\\x')).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
  });
});

describe('ThemeEditorPanel schema', () => {
  it('gera id custom-* válido', async () => {
    const { importedThemeSchema } = await import('../../../shared/settings-types');
    const ok = importedThemeSchema.safeParse({
      id: `custom-${slugify('Meu Tema')}`,
      label: 'Meu tema',
      appearance: 'dark',
      ui: Object.fromEntries(
        [
          'bg','bgElevated','bgBar','border','borderStrong','text','textDim',
          'textFaint','accent','accentInk','btnPrimary','btnPrimaryInk',
          'btnPrimaryHover','danger',
        ].map((k) => [k, '#000000']),
      ),
      terminal: Object.fromEntries(
        [
          'background','foreground','cursor','cursorAccent','selectionBackground',
          'black','red','green','yellow','blue','magenta','cyan','white',
          'brightBlack','brightRed','brightGreen','brightYellow','brightBlue',
          'brightMagenta','brightCyan','brightWhite',
        ].map((k) => [k, '#000000']),
      ),
    });
    expect(ok.success).toBe(true);
  });
});

describe('ThemeEditorPanel appearance', () => {
  const roots: Root[] = [];

  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.theme;
  });

  function mountEditor(
    themeId: keyof typeof PALETTES,
    activeImported: ImportedTheme | null = null,
  ): { host: HTMLElement; onSave: ReturnType<typeof vi.fn> } {
    const onSave = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        <ThemeEditorPanel
          themeId={themeId}
          activeImported={activeImported}
          onSave={onSave}
          onClose={() => {}}
        />,
      ),
    );
    return { host, onSave };
  }

  function swatch(host: HTMLElement, label: string): HTMLInputElement {
    const field = [...host.querySelectorAll('label.theme-editor__field')].find(
      (candidate) => candidate.querySelector('span')?.textContent === label,
    );
    const input = field?.querySelector<HTMLInputElement>('input[type="color"]');
    if (!input) throw new Error(`Color field was not rendered: ${label}`);
    return input;
  }

  function pick(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!setter) throw new Error('HTMLInputElement value setter unavailable');
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function save(host: HTMLElement): void {
    const button = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Salvar tema',
    );
    if (!button) throw new Error('Save button was not rendered');
    act(() => button.click());
  }

  it('follows the background luminance, not the id of the theme the editor started from', () => {
    const light = mountEditor('nexus-dark');
    pick(swatch(light.host, 'Fundo'), '#ffffff');
    // The live preview must flip the native-control side right away...
    expect(document.documentElement.dataset.theme).toBe('nexus-light');
    save(light.host);
    // ...and the saved theme must carry the same side.
    expect(light.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: 'light' }),
    );
  });

  it('turns a light built-in into a dark theme when its background goes dark', () => {
    const dark = mountEditor('nexus-light');
    pick(swatch(dark.host, 'Fundo'), '#101014');
    expect(document.documentElement.dataset.theme).toBe('nexus-pink-city');
    save(dark.host);
    expect(dark.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: 'dark' }),
    );
  });

  it('keeps an imported light theme light when it is the base of the copy', () => {
    const imported = parseVsCodeThemeFile({
      name: 'Paper',
      colors: { 'editor.background': '#fbfbfb', 'editor.foreground': '#1f2328' },
    });
    expect(imported.appearance).toBe('light');
    const { host, onSave } = mountEditor('nexus-dark', imported);
    save(host);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: 'light' }),
    );
  });

  it.each(Object.keys(PALETTES) as Array<keyof typeof PALETTES>)(
    'saves %s with the side it already had when nothing is edited',
    (themeId) => {
      const { host, onSave } = mountEditor(themeId);
      save(host);
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          appearance: themeId === 'nexus-light' ? 'light' : 'dark',
        }),
      );
    },
  );
});
