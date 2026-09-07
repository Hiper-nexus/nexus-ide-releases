import {
  DEFAULT_TERMINAL_SETTINGS,
  type TerminalThemeId,
} from "../../shared/settings-types";

/**
 * App-wide UI palettes, one per terminal theme. Selecting a theme in
 * Settings → Aparência restyles the whole IDE (bar, drawers, launcher,
 * panels) by overriding CSS custom properties on :root. Terminal panes get
 * the selected xterm palette independently via terminal-host.
 *
 * Derivados do acento (--accent-soft/strong/hover/glow) NÃO moram aqui:
 * base.css os computa com color-mix a partir de --accent, então cada tema
 * os herda corretamente de graça. Aqui só entra o que não dá para derivar,
 * incluindo --text-faint, a tinta sobre acento e o CTA neutro por tema.
 */

export interface UiPalette {
  bg: string;
  bgElevated: string;
  bgBar: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentInk: string;
  btnPrimary: string;
  btnPrimaryInk: string;
  btnPrimaryHover: string;
  danger: string;
}

/**
 * Paleta ciano legada (mantida para integrações antigas). NÃO apagada:
 * a Camada 2 a registra como tema selecionável ("nexus-legacy"), o que exige
 * ampliar TERMINAL_THEME_IDS em src/shared/settings-types.ts + o picker de
 * Settings — ambos fora do escopo styles/ desta camada.
 */
export const LEGACY_NEXUS_CYAN_PALETTE: UiPalette = {
  bg: "#0a0e15",
  bgElevated: "#101623",
  bgBar: "#0c1119",
  border: "#1d2637",
  borderStrong: "#2c3a55",
  text: "#d7dfec",
  textDim: "#8a94aa",
  textFaint: "#8f8f8f",
  accent: "#3dd9ff",
  accentInk: "#051019",
  btnPrimary: "#fafafa",
  btnPrimaryInk: "#0b0b0c",
  btnPrimaryHover: "#ffffff",
  danger: "#ff7a90",
};

/**
 * Exported because `--bg`, `--bg-elevated` and `--bg-bar` are written inline by
 * `applyUiTheme` and never declared in base.css, so anything that has to know a
 * theme's real background — the palette contrast gate and palette-gen.test.ts —
 * has to read them from here rather than from the stylesheet.
 */
export const PALETTES: Record<TerminalThemeId, UiPalette> = {
  // Pink City is the product default. The pink signal is reserved for live,
  // selected and focused state; the primary action stays neutral-white.
  "nexus-pink-city": {
    bg: "#080709",
    bgElevated: "#111013",
    bgBar: "#0d0b0f",
    border: "rgb(255 255 255 / 0.08)",
    borderStrong: "rgb(255 255 255 / 0.16)",
    text: "#faf7f9",
    textDim: "#aaa2a8",
    textFaint: "#928b90",
    accent: "#ff4f8b",
    accentInk: "#080709",
    btnPrimary: "#faf7f9",
    btnPrimaryInk: "#080709",
    btnPrimaryHover: "#fffafd",
    danger: "#ff6b4a",
  },
  // Nexus Dark remains the stable neutral/indigo selectable palette from 0.21.
  "nexus-dark": {
    bg: "#0b0b0c",
    bgElevated: "#141416",
    bgBar: "#101012",
    border: "rgb(255 255 255 / 0.07)",
    borderStrong: "rgb(255 255 255 / 0.14)",
    text: "#fafafa",
    textDim: "#a1a1a1",
    textFaint: "#8f8f8f",
    accent: "#7c86ff",
    accentInk: "#0b0b0c",
    btnPrimary: "#fafafa",
    btnPrimaryInk: "#0b0b0c",
    btnPrimaryHover: "#ffffff",
    danger: "#f85149",
  },
  // Nexus Gray (Cinza, paridade 1.3): neutro quente-frio de baixa saturação.
  "nexus-gray": {
    bg: "#141518",
    bgElevated: "#1b1d21",
    bgBar: "#17191d",
    border: "rgb(255 255 255 / 0.08)",
    borderStrong: "rgb(255 255 255 / 0.16)",
    text: "#e4e6ea",
    textDim: "#a3a7ae",
    textFaint: "#8b9098",
    accent: "#9aa5b1",
    accentInk: "#141518",
    btnPrimary: "#e4e6ea",
    btnPrimaryInk: "#141518",
    btnPrimaryHover: "#f5f6f8",
    danger: "#e06c6c",
  },
  // Nexus Red (Vermelho, paridade 1.3.9): acento quente em fundo carvão.
  "nexus-red": {
    bg: "#120c0d",
    bgElevated: "#1a1113",
    bgBar: "#160e10",
    border: "rgb(255 255 255 / 0.07)",
    borderStrong: "rgb(255 255 255 / 0.14)",
    text: "#f2e6e7",
    textDim: "#ab9497",
    textFaint: "#947c7f",
    accent: "#ff6b5e",
    accentInk: "#120c0d",
    btnPrimary: "#f2e6e7",
    btnPrimaryInk: "#120c0d",
    btnPrimaryHover: "#faf0f1",
    danger: "#ff8578",
  },
  "nexus-light": {
    bg: "#f7f8fb",
    bgElevated: "#ffffff",
    bgBar: "#eef1f6",
    border: "#dde3ee",
    borderStrong: "#c3cddf",
    text: "#2a3040",
    textDim: "#5d6880",
    textFaint: "#6b7080",
    // ≥4.5:1 tanto sobre --bg-bar quanto sobre --bg para rótulos pequenos,
    // mantendo também texto branco AA no acento sólido.
    accent: "#0b70b4",
    accentInk: "#ffffff",
    btnPrimary: "#16181d",
    btnPrimaryInk: "#fafafa",
    btnPrimaryHover: "#23262e",
    danger: "#c73a52",
  },
  dracula: {
    bg: "#282a36",
    bgElevated: "#2f3242",
    bgBar: "#21222c",
    border: "#3b3e51",
    borderStrong: "#4d5170",
    text: "#f8f8f2",
    // 5.79:1 sobre o elevated; metadados pequenos continuam AA.
    textDim: "#a8aecb",
    textFaint: "#979dba",
    accent: "#bd93f9",
    accentInk: "#14101f",
    btnPrimary: "#fafafa",
    btnPrimaryInk: "#0b0b0c",
    btnPrimaryHover: "#ffffff",
    danger: "#ff7a90",
  },
  "solarized-dark": {
    bg: "#002b36",
    bgElevated: "#073642",
    bgBar: "#01313d",
    border: "#0e4250",
    borderStrong: "#1a5261",
    text: "#93a1a1",
    // 5.08:1 sobre o elevated (o cinza Solarized canônico é insuficiente
    // para os rótulos de 10–12 px usados pelo cockpit).
    textDim: "#8fa6aa",
    textFaint: "#8ca0a3",
    accent: "#2aa4e8",
    accentInk: "#01222c",
    btnPrimary: "#fafafa",
    btnPrimaryInk: "#0b0b0c",
    btnPrimaryHover: "#ffffff",
    danger: "#ff7a70",
  },
};

const VAR_MAP: Array<[keyof UiPalette, string]> = [
  ["bg", "--bg"],
  ["bgElevated", "--bg-elevated"],
  ["bgBar", "--bg-bar"],
  ["border", "--border"],
  ["borderStrong", "--border-strong"],
  ["text", "--text"],
  ["textDim", "--text-dim"],
  ["textFaint", "--text-faint"],
  ["accent", "--accent"],
  ["accentInk", "--accent-ink"],
  ["btnPrimary", "--btn-primary"],
  ["btnPrimaryInk", "--btn-primary-ink"],
  ["btnPrimaryHover", "--btn-primary-hover"],
  ["danger", "--danger"],
];

/** Vars que versões antigas setavam inline e hoje pertencem ao base.css. */
const LEGACY_INLINE_VARS = ["--accent-soft", "--accent-glow"];

/** Restyle the whole app to the palette matching the selected theme. */
export function applyUiTheme(themeId: TerminalThemeId): void {
  const palette =
    PALETTES[themeId] ?? PALETTES[DEFAULT_TERMINAL_SETTINGS.themeId];
  const root = document.documentElement;
  for (const [key, cssVar] of VAR_MAP) {
    root.style.setProperty(cssVar, palette[key]);
  }
  // Um valor inline antigo venceria base.css para sempre; limpar garante que
  // derivados e defaults estáticos acompanhem o tema atual.
  for (const cssVar of LEGACY_INLINE_VARS) {
    root.style.removeProperty(cssVar);
  }
  root.dataset.theme = themeId;
  // Plataforma exposta ao CSS: padding dos traffic lights só faz sentido no
  // mac (hiddenInset); win/linux têm titlebar nativa (default) e o espaço é
  // desperdiçado. Barato setar aqui — applyUiTheme roda no boot e no reload.
  const p = window.nexus?.platform;
  root.dataset.platform =
    p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux";
}

/**
 * Liga/desliga o MODO PIXEL da identidade visual: seta `data-theme-pixel` no
 * <html>, que ativa o bloco de overrides em base.css — todos os `--radius-*`
 * viram 0, `--font-ui` passa a ser a fonte bitmap (`--font-pixel`/VT323) e o
 * antialias do body é desligado. Reversível e ortogonal ao tema de cores
 * (applyUiTheme). Ligado em Settings → Aparência e persistido em ~/.nexus/settings.json.
 */
export function applyPixelMode(on: boolean): void {
  const root = document.documentElement;
  if (on) {
    root.dataset.themePixel = "on";
  } else {
    delete root.dataset.themePixel;
  }
}
