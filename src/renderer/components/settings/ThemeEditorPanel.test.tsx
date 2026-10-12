/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { slugify, toOpaqueHex } from './ThemeEditorPanel';

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
