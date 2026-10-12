import { useMemo, useState } from 'react';
import {
  IMPORTED_TERMINAL_KEYS,
  type ImportedTheme,
} from '../../../shared/settings-types';
import { PALETTES, applyUiTheme, type UiPalette } from '../../styles/ui-theme';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';

/**
 * Editor de temas (herdado do t3code ThemeEditor): a pessoa ajusta as cores
 * do papel (canvas, acento, CTA, perigo…) e salva como tema `custom-*` na
 * mesma lista dos importados do VS Code. Prévia ao vivo — o draft pinta o
 * app inteiro enquanto se edita; "Cancelar" restaura o tema ativo.
 */

const UI_LABELS: Record<keyof UiPalette, string> = {
  bg: 'Fundo',
  bgElevated: 'Superfície',
  bgBar: 'Barra',
  border: 'Borda',
  borderStrong: 'Borda forte',
  text: 'Texto',
  textDim: 'Texto suave',
  textFaint: 'Texto fraco',
  accent: 'Acento',
  accentInk: 'Tinta do acento',
  btnPrimary: 'CTA',
  btnPrimaryInk: 'Tinta do CTA',
  btnPrimaryHover: 'CTA hover',
  danger: 'Perigo',
};

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgb | null {
  const hex6 = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex6) {
    const n = Number.parseInt(hex6[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (hex3) {
    const [r, g, b] = hex3[1]!.split('');
    return {
      r: Number.parseInt(r! + r!, 16),
      g: Number.parseInt(g! + g!, 16),
      b: Number.parseInt(b! + b!, 16),
      a: 1,
    };
  }
  const rgb = /rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?/i.exec(
    value,
  );
  if (rgb) {
    return {
      r: Math.max(0, Math.min(255, Number.parseInt(rgb[1]!, 10))),
      g: Math.max(0, Math.min(255, Number.parseInt(rgb[2]!, 10))),
      b: Math.max(0, Math.min(255, Number.parseInt(rgb[3]!, 10))),
      a:
        rgb[4] === undefined
          ? 1
          : Math.max(0, Math.min(1, Number.parseFloat(rgb[4]))),
    };
  }
  return null;
}

function rgbToHex({ r, g, b }: Rgb): string {
  const n = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${n(r)}${n(g)}${n(b)}`;
}

function flattenOver(fg: Rgb, base: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + base.r * (1 - a),
    g: fg.g * a + base.g * (1 - a),
    b: fg.b * a + base.b * (1 - a),
    a: 1,
  };
}

/**
 * Qualquer cor CSS vira `#rrggbb` opaco. Alfa é achato SOBRE `base`
 * (o `bg` do papel) — nunca sobre preto: `rgb(255 255 255 / .08)` da borda
 * do Pink City viraria branco sólido e a UI inteira estouraria de contraste.
 */
export function toOpaqueHex(value: string, base = '#000000'): string {
  const fg = parseColor(value);
  if (!fg) return '#000000';
  const bg = parseColor(base) ?? { r: 0, g: 0, b: 0, a: 1 };
  return rgbToHex(fg.a >= 1 ? fg : flattenOver(fg, bg));
}

function paletteToHex(palette: UiPalette): Record<keyof UiPalette, string> {
  const bg = toOpaqueHex(palette.bg, '#000000');
  const out = {} as Record<keyof UiPalette, string>;
  for (const key of Object.keys(UI_LABELS) as Array<keyof UiPalette>) {
    // Superfícies/bordas com alfa se resolvem sobre o fundo do papel.
    out[key] = toOpaqueHex(palette[key], bg);
  }
  return out;
}

function terminalFromTheme(themeId: keyof typeof PALETTES): ImportedTheme['terminal'] {
  const base =
    TERMINAL_THEMES[themeId]?.theme ?? TERMINAL_THEMES['nexus-pink-city'].theme;
  const out = {} as ImportedTheme['terminal'];
  for (const key of IMPORTED_TERMINAL_KEYS) {
    const value = base[key];
    out[key] = typeof value === 'string' ? toOpaqueHex(value) : '#000000';
  }
  return out;
}

export function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'tema';
}

type Props = {
  /** Tema embutido ativo (quando não há importado). */
  themeId: keyof typeof PALETTES;
  activeImported: ImportedTheme | null;
  onSave: (theme: ImportedTheme) => void;
  onClose: () => void;
};

export function ThemeEditorPanel({
  themeId,
  activeImported,
  onSave,
  onClose,
}: Props) {
  const seed = useMemo(() => {
    const palette: UiPalette = activeImported
      ? { ...PALETTES[themeId], ...activeImported.ui }
      : PALETTES[themeId];
    return paletteToHex(palette);
  }, [themeId, activeImported]);

  const [label, setLabel] = useState(
    activeImported ? `${activeImported.label} (cópia)` : 'Meu tema',
  );
  const [colors, setColors] = useState(seed);

  const preview: ImportedTheme = {
    id: 'custom-preview',
    label,
    appearance: themeId === 'nexus-light' ? 'light' : 'dark',
    ui: colors,
    terminal: terminalFromTheme(themeId),
  };

  const applyDraft = (next: typeof colors) => {
    setColors(next);
    applyUiTheme(themeId, { ...preview, ui: next });
  };

  const restore = () => {
    applyUiTheme(themeId, activeImported);
    onClose();
  };

  const save = () => {
    const id = `custom-${slugify(label)}`;
    const theme: ImportedTheme = {
      id,
      label: label.trim().slice(0, 48) || 'Meu tema',
      appearance: preview.appearance,
      ui: colors,
      terminal: preview.terminal,
    };
    onSave(theme);
  };

  return (
    <div className="theme-editor" role="dialog" aria-label="Editor de temas">
      <div className="theme-editor__head">
        <h3 className="theme-editor__title">Editor de temas</h3>
        <p className="theme-editor__hint">
          Ajuste as cores do papel. A prévia pinta o app inteiro — ao salvar,
          o tema entra na grade ao lado dos importados.
        </p>
      </div>

      <label className="theme-editor__field">
        <span>Nome</span>
        <input
          className="theme-editor__input"
          value={label}
          maxLength={48}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      <div className="theme-editor__grid">
        {(Object.keys(UI_LABELS) as Array<keyof UiPalette>).map((key) => (
          <label key={key} className="theme-editor__field">
            <span>{UI_LABELS[key]}</span>
            <input
              type="color"
              className="theme-editor__swatch"
              value={colors[key]}
              onChange={(e) => applyDraft({ ...colors, [key]: e.target.value })}
            />
            <code className="theme-editor__hex">{colors[key]}</code>
          </label>
        ))}
      </div>

      <div className="theme-editor__actions">
        <button type="button" className="theme-editor__btn" onClick={restore}>
          Cancelar
        </button>
        <button
          type="button"
          className="theme-editor__btn theme-editor__btn--primary"
          onClick={save}
        >
          Salvar tema
        </button>
      </div>
    </div>
  );
}
