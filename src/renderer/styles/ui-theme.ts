import type { TerminalThemeId } from "../../shared/settings-types";

/**
 * App-wide UI palettes, one per terminal theme. Selecting a theme in
 * Settings → Terminal restyles the WHOLE IDE (bar, drawers, launcher,
 * panels) by overriding the CSS custom properties on :root — the terminal
 * panes get their matching xterm palette via terminal-host.
 *
 * Derivados do acento (--accent-soft/strong/hover/glow) NÃO moram aqui:
 * base.css os computa com color-mix a partir de --accent, então cada tema
 * os herda corretamente de graça. Aqui só entra o que não dá para derivar —
 * incluindo --accent-ink (tinta sobre CTA sólido), que é decisão de
 * contraste por tema, não conta de cor.
 */

interface UiPalette {
  bg: string;
  bgElevated: string;
  bgBar: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  accent: string;
  accentInk: string;
  danger: string;
}

const PALETTES: Record<TerminalThemeId, UiPalette> = {
  "nexus-dark": {
    bg: "#0a0e15",
    bgElevated: "#101623",
    bgBar: "#0c1119",
    border: "#1d2637",
    borderStrong: "#2c3a55",
    text: "#d7dfec",
    // ≥5:1 sobre --bg e --bg-elevated (WCAG AA). Não baixar — tem que casar
    // com o valor de base.css:root.
    textDim: "#8a94aa",
    // Ciano operacional: o que está VIVO (agente ativo, ação primária).
    accent: "#3dd9ff",
    accentInk: "#051019",
    danger: "#ff7a90",
  },
  "nexus-light": {
    bg: "#f7f8fb",
    bgElevated: "#ffffff",
    bgBar: "#eef1f6",
    border: "#dde3ee",
    borderStrong: "#c3cddf",
    text: "#2a3040",
    textDim: "#5d6880",
    // ≥4.5:1 tanto sobre --bg-bar quanto sobre --bg para rótulos pequenos,
    // mantendo também texto branco AA no CTA sólido.
    accent: "#0b70b4",
    accentInk: "#ffffff",
    danger: "#c73a52",
  },
  dracula: {
    bg: "#282a36",
    bgElevated: "#2f3242",
    bgBar: "#21222c",
    border: "#3b3e51",
    borderStrong: "#4d5170",
    text: "#f8f8f2",
    // 5.79:1 sobre o elevated — metadados pequenos continuam AA.
    textDim: "#a8aecb",
    accent: "#bd93f9",
    accentInk: "#14101f",
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
    accent: "#2aa4e8",
    accentInk: "#01222c",
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
  ["accent", "--accent"],
  ["accentInk", "--accent-ink"],
  ["danger", "--danger"],
];

/** Vars que versões antigas setavam inline e hoje são derivadas em CSS. */
const LEGACY_INLINE_VARS = ["--accent-soft"];

/** Restyle the whole app to the palette matching the selected theme. */
export function applyUiTheme(themeId: TerminalThemeId): void {
  const palette = PALETTES[themeId] ?? PALETTES["nexus-dark"];
  const root = document.documentElement;
  for (const [key, cssVar] of VAR_MAP) {
    root.style.setProperty(cssVar, palette[key]);
  }
  // Um set inline antigo venceria o color-mix de base.css para sempre;
  // limpar garante que os derivados sigam o acento do tema atual.
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
