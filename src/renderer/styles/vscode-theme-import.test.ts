/** @vitest-environment jsdom */
// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos de apps/web/src/vscodeThemeImport.test.ts (alpha, foreground ilegível, foco transparente, P3, nome humanizado, sem editor.background) reescritos contra a UiPalette/xterm do Nexus; novos casos de CTA neutro, cor inválida/CSS recusado, piso AA em todas as superfícies, id estável, JSONC e aplicação no <html>.
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_IMPORTED_THEMES,
  importedThemeSchema,
  uiSettingsSchema,
  type ImportedTheme,
} from '../../shared/settings-types';
import { contrastRatio, hexToOklch } from './palette-gen';
import { PALETTES, applyUiTheme, resolveImportedTheme } from './ui-theme';
import {
  flattenOver,
  isVsCodeThemeFile,
  parseVsCodeColor,
  parseVsCodeThemeFile,
  parseVsCodeThemeText,
  upsertImportedTheme,
} from './vscode-theme-import';

// Shaped like a real workbench theme: dotted keys, alpha overlays, and a lot
// of roles simply left out.
const VSCODE_DARK = {
  name: 'pierre-dark-soft',
  type: 'dark',
  colors: {
    'editor.background': '#171717',
    'editor.foreground': '#d4d4d4',
    foreground: '#d4d4d4',
    'sideBar.background': '#101010',
    focusBorder: '#69b1ff',
    'button.background': '#69b1ff',
    'button.foreground': '#171717',
    'terminal.background': '#101010',
    'terminal.foreground': '#8a8a8a',
    'terminal.ansiRed': '#ff5f5f',
  },
  tokenColors: [],
};

function minContrast(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

function surfacesOf(theme: ImportedTheme): string[] {
  return [theme.ui.bg, theme.ui.bgElevated, theme.ui.bgBar];
}

describe('importar tema do VS Code', () => {
  it('reconhece temas do workbench e recusa o resto', () => {
    expect(isVsCodeThemeFile(VSCODE_DARK)).toBe(true);
    expect(isVsCodeThemeFile({ type: 'dark', tokenColors: [] })).toBe(true);
    expect(isVsCodeThemeFile({ colors: { canvas: '#ffffff' } })).toBe(false);
    expect(isVsCodeThemeFile('nope')).toBe(false);
  });

  it('leva fundo, texto, acento, barra e terminal do arquivo', () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    expect(theme.label).toBe('Pierre Dark Soft');
    expect(theme.appearance).toBe('dark');
    expect(theme.ui.bg).toBe('#171717');
    expect(theme.ui.text).toBe('#d4d4d4');
    expect(theme.ui.accent).toBe('#69b1ff');
    expect(theme.ui.bgBar).toBe('#101010');
    expect(theme.terminal.background).toBe('#101010');
    expect(theme.terminal.red).toBe('#ff5f5f');
    // ANSI omitido vem da paleta embutida escura.
    expect(theme.terminal.green).toBe('#9ece6a');
  });

  it('compõe alpha sobre a superfície onde a cor pousa', () => {
    expect(flattenOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 })).toBe(
      '#808080',
    );
    const theme = parseVsCodeThemeFile({
      name: 'Alpha',
      colors: {
        'editor.background': '#000000',
        'editor.foreground': '#ffffff',
        // #ffffff80 sobre #000000 → #808080 (5,3:1), não um valor translúcido.
        descriptionForeground: '#ffffff80',
        'terminal.background': '#000000',
        'terminal.selectionBackground': '#ff000080',
      },
    });
    expect(theme.ui.textDim).toBe('#808080');
    expect(theme.terminal.selectionBackground).toBe('#800000');
  });

  it('recusa cor inválida e nunca deixa CSS arbitrário sair do parser', () => {
    for (const bad of [
      'red',
      'rgb(1, 2, 3)',
      '#12345',
      '#ff0000; background: url(x)',
      'url(javascript:alert(1))',
      'var(--accent)',
      42,
      null,
    ]) {
      expect(parseVsCodeColor(bad)).toBeNull();
    }
    const theme = parseVsCodeThemeFile({
      name: 'Hostile',
      colors: {
        'editor.background': '#101010',
        'editor.foreground': '#fff; --accent: url(evil)',
        focusBorder: 'expression(alert(1))',
      },
    });
    expect(theme.ui.text).toBe(PALETTES['nexus-pink-city'].text);
    for (const value of [...Object.values(theme.ui), ...Object.values(theme.terminal)]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    // O schema de persistência é a segunda barreira: só hex opaco entra.
    expect(
      importedThemeSchema.safeParse({
        ...theme,
        ui: { ...theme.ui, accent: 'red; background: url(evil)' },
      }).success,
    ).toBe(false);
    expect(() =>
      parseVsCodeThemeFile({ name: 'Sem fundo', colors: { 'editor.background': 'blue' } }),
    ).toThrow(/editor\.background/);
  });

  it('garante AA em todas as superfícies, mesmo com cores ilegíveis no arquivo', () => {
    const dark = parseVsCodeThemeFile({
      name: 'Unreadable',
      type: 'dark',
      colors: {
        'editor.background': '#101010',
        'editor.foreground': '#111111',
        descriptionForeground: '#1a1a1a',
        disabledForeground: '#202020',
        'editorError.foreground': '#300000',
        'editorWidget.background': '#2a2a2a',
        'titleBar.activeBackground': '#050505',
        focusBorder: '#2a2a40',
        'terminal.background': '#fbfbfb',
        'terminal.foreground': '#f0f0f0',
      },
    });
    const light = parseVsCodeThemeFile({
      name: 'Pale',
      type: 'light',
      colors: {
        'editor.background': '#fafafa',
        'editor.foreground': '#eeeeee',
        focusBorder: '#ffe9a8',
      },
    });
    for (const theme of [dark, light]) {
      const surfaces = surfacesOf(theme);
      for (const role of ['text', 'textDim', 'textFaint', 'accent', 'danger'] as const) {
        expect(minContrast(theme.ui[role], surfaces), role).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(theme.ui.accentInk, theme.ui.accent)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.terminal.foreground, theme.terminal.background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.terminal.cursor, theme.terminal.background)).toBeGreaterThanOrEqual(3);
    }
    expect(dark.ui.text).not.toBe('#111111');
  });

  it('ajusta só a luminosidade do acento fraco, mantendo o matiz do tema', () => {
    // Dark+: focusBorder #007fd4 mede 3,9:1 sobre #1e1e1e.
    const theme = parseVsCodeThemeFile({
      name: 'Dark+',
      colors: { 'editor.background': '#1e1e1e', focusBorder: '#007fd4' },
    });
    expect(theme.ui.accent).not.toBe('#007fd4');
    expect(minContrast(theme.ui.accent, surfacesOf(theme))).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hexToOklch(theme.ui.accent).h - hexToOklch('#007fd4').h)).toBeLessThan(10);
  });

  it('pula um focusBorder transparente para a próxima chave visível', () => {
    const theme = parseVsCodeThemeFile({
      name: 'Vitesse Dark',
      colors: {
        'editor.background': '#121212',
        focusBorder: '#00000000',
        'button.background': '#4d9375',
      },
    });
    expect(theme.ui.accent).toBe('#4d9375');
  });

  it('mantém o CTA primário neutro, nunca o acento nem button.background', () => {
    const vivid = {
      'button.background': '#ff00ff',
      'button.foreground': '#00ff00',
      focusBorder: '#ff00ff',
    };
    const dark = parseVsCodeThemeFile({
      name: 'Neon',
      colors: { 'editor.background': '#14141a', ...vivid },
    });
    const light = parseVsCodeThemeFile({
      name: 'Neon Light',
      colors: { 'editor.background': '#ffffff', ...vivid },
    });
    expect(dark.ui.accent).toBe('#ff00ff');
    expect([dark.ui.btnPrimary, dark.ui.btnPrimaryInk, dark.ui.btnPrimaryHover]).toEqual([
      PALETTES['nexus-dark'].btnPrimary,
      PALETTES['nexus-dark'].btnPrimaryInk,
      PALETTES['nexus-dark'].btnPrimaryHover,
    ]);
    expect([light.ui.btnPrimary, light.ui.btnPrimaryInk, light.ui.btnPrimaryHover]).toEqual([
      PALETTES['nexus-light'].btnPrimary,
      PALETTES['nexus-light'].btnPrimaryInk,
      PALETTES['nexus-light'].btnPrimaryHover,
    ]);
  });

  it('segue o fundo real para claro/escuro, mesmo com type errado', () => {
    const lying = parseVsCodeThemeFile({
      name: 'Lying',
      type: 'dark',
      colors: { 'editor.background': '#fdfdfd', 'editor.foreground': '#202020' },
    });
    expect(lying.appearance).toBe('light');
    expect(lying.ui.btnPrimary).toBe(PALETTES['nexus-light'].btnPrimary);
  });

  it('lê color(display-p3 …) de temas de gamut amplo', () => {
    const theme = parseVsCodeThemeFile({
      name: 'Vibrant',
      colors: {
        'editor.background': 'color(display-p3 0.039216 0.039216 0.039216)',
        'editor.foreground': 'color(display-p3 0.980392 0.980392 0.980392)',
        focusBorder: 'color(display-p3 0.308664 0.645271 1.000000)',
      },
    });
    expect(theme.ui.bg).toMatch(/^#0[89ab]/);
    expect(theme.ui.text).toMatch(/^#f[a-f0-9]/);
    const [red, green, blue] = [1, 3, 5].map((index) =>
      Number.parseInt(theme.ui.accent.slice(index, index + 2), 16),
    ) as [number, number, number];
    expect(blue).toBeGreaterThan(200);
    expect(blue).toBeGreaterThan(red);
    expect(green).toBeGreaterThan(red);
  });

  it('gera nomes e ids estáveis', () => {
    const first = parseVsCodeThemeFile(VSCODE_DARK);
    const again = parseVsCodeThemeFile(structuredClone(VSCODE_DARK));
    expect(first.id).toBe('vscode-pierre-dark-soft');
    expect(again).toEqual(first);
    expect(
      parseVsCodeThemeFile({
        displayName: '---',
        name: 'night-owl',
        colors: { 'editor.background': '#011627' },
      }).label,
    ).toBe('Night Owl');
    expect(
      parseVsCodeThemeFile({
        displayName: 'One Dark Pro',
        name: 'material-theme',
        colors: { 'editor.background': '#282c34' },
      }).id,
    ).toBe('vscode-one-dark-pro');
    // Nome sem [a-z0-9]: id por hash do próprio nome, estável e sem colidir.
    const cyrillic = (name: string) =>
      parseVsCodeThemeFile({ name, colors: { 'editor.background': '#101010' } }).id;
    expect(cyrillic('Тёмная')).toBe(cyrillic('Тёмная'));
    expect(cyrillic('Тёмная')).not.toBe(cyrillic('Светлая'));
    expect(cyrillic('Тёмная')).toMatch(/^vscode-[a-z0-9]+$/);
  });

  it('reimportar substitui no lugar; tema novo entra no fim até o limite', () => {
    const a = parseVsCodeThemeFile(VSCODE_DARK);
    const b = parseVsCodeThemeFile({ name: 'B', colors: { 'editor.background': '#ffffff' } });
    const a2 = parseVsCodeThemeFile({
      ...VSCODE_DARK,
      colors: { ...VSCODE_DARK.colors, focusBorder: '#ffb86c' },
    });
    const list = upsertImportedTheme(upsertImportedTheme([], a), b);
    const replaced = upsertImportedTheme(list, a2);
    expect(replaced.map((theme) => theme.id)).toEqual([a.id, b.id]);
    expect(replaced[0]!.ui.accent).toBe('#ffb86c');
    const full = Array.from({ length: MAX_IMPORTED_THEMES }, (_, index) => ({
      ...a,
      id: `vscode-t${index}`,
    }));
    expect(() => upsertImportedTheme(full, b)).toThrow(/Limite/);
    expect(upsertImportedTheme(full, { ...a2, id: 'vscode-t3' })).toHaveLength(MAX_IMPORTED_THEMES);
  });

  it('aceita JSONC com comentários e vírgula final e explica arquivos errados', () => {
    const theme = parseVsCodeThemeText(`{
      // tema gravado pelo VS Code
      "name": "Commented",
      "colors": {
        "editor.background": "#1e1e2e", /* fundo */
        "editor.foreground": "#cdd6f4",
      },
    }`);
    expect(theme.ui.bg).toBe('#1e1e2e');
    expect(() => parseVsCodeThemeText('{ nope')).toThrow(/JSON válido/);
    expect(() => parseVsCodeThemeText('{"name":"x","colors":{"bg":"#000"}}')).toThrow(
      /tema de cores do VS Code/,
    );
    expect(() => parseVsCodeThemeText(' '.repeat(2_000_001))).toThrow(/grande demais/);
  });

  it('lê settings.json tolerante: tema corrompido cai sozinho', () => {
    const good = parseVsCodeThemeFile(VSCODE_DARK);
    const parsed = uiSettingsSchema.parse({
      pixelMode: true,
      importedThemes: [good, { ...good, id: 'vscode-bad', ui: { ...good.ui, bg: 'red' } }],
      activeImportedThemeId: good.id,
    });
    expect(parsed.pixelMode).toBe(true);
    expect(parsed.importedThemes.map((theme) => theme.id)).toEqual([good.id]);
    expect(uiSettingsSchema.parse({ importedThemes: 'lixo' }).importedThemes).toEqual([]);
  });
});

describe('aplicar tema importado', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.theme;
  });

  it('aplica paleta e rampa do tema importado e as limpa ao voltar ao embutido', () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    const root = document.documentElement;
    applyUiTheme('nexus-pink-city', theme);
    expect(root.style.getPropertyValue('--bg')).toBe(theme.ui.bg);
    expect(root.style.getPropertyValue('--btn-primary')).toBe(PALETTES['nexus-dark'].btnPrimary);
    expect(root.style.getPropertyValue('--surface-0')).toMatch(/^#[0-9a-f]{6}$/);
    expect(root.dataset.theme).toBe('nexus-pink-city');

    applyUiTheme('nexus-pink-city', parseVsCodeThemeFile({
      name: 'Claro',
      colors: { 'editor.background': '#ffffff' },
    }));
    expect(root.dataset.theme).toBe('nexus-light');

    applyUiTheme('dracula');
    expect(root.style.getPropertyValue('--bg')).toBe(PALETTES.dracula.bg);
    expect(root.style.getPropertyValue('--surface-0')).toBe('');
    expect(root.dataset.theme).toBe('dracula');
  });

  it('só resolve o tema ativo quando ele ainda é só hex', () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    expect(
      resolveImportedTheme({ importedThemes: [theme], activeImportedThemeId: theme.id }),
    ).toBe(theme);
    expect(resolveImportedTheme({ importedThemes: [theme], activeImportedThemeId: '' })).toBeNull();
    const tampered = { ...theme, ui: { ...theme.ui, bg: 'url(evil)' } };
    expect(
      resolveImportedTheme({ importedThemes: [tampered], activeImportedThemeId: theme.id }),
    ).toBeNull();
  });
});
