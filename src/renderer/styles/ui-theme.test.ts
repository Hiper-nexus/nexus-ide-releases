/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalThemeId } from "../../shared/settings-types";
import { applyUiTheme, LEGACY_NEXUS_CYAN_PALETTE } from "./ui-theme";

// jsdom rewrites import.meta.url to an http URL, so the stylesheets are read
// from the vitest root (the repo) instead of relative to this module.
function readStyles(file: string): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), "src/renderer/styles", file),
    "utf8",
  );
}

const baseCss = readStyles("base.css");
const panelsCss = readStyles("panels.css");
const settingsCss = readStyles("settings.css");

/** Body of the first rule matching `selector`, in the given stylesheet. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

/** Value a theme resolves for a token: its own block, else the :root default. */
function tokenForTheme(themeId: TerminalThemeId, token: string): string {
  const scoped = ruleBody(baseCss, `[data-theme='${themeId}']`);
  const own = scoped.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
  const root = ruleBody(baseCss, ":root").match(
    new RegExp(`${token}:\\s*([^;]+);`),
  )?.[1];
  return (own ?? root ?? "").trim();
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = channel((value >> 16) & 0xff);
  const green = channel((value >> 8) & 0xff);
  const blue = channel(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Nexus Light UI palette", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.platform;
  });

  it("keeps accent text and the solid CTA at WCAG AA contrast", () => {
    applyUiTheme("nexus-light");
    const root = document.documentElement.style;
    const accent = root.getPropertyValue("--accent");
    const accentInk = root.getPropertyValue("--accent-ink");

    expect(
      contrast(accent, root.getPropertyValue("--bg-bar")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(accent, root.getPropertyValue("--bg")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accentInk, accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Nexus operational dark default palette", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.platform;
  });

  // REGRESSAO (0.21): o redesign trocou o acento para indigo, mas a mudanca se
  // perdeu no working tree e o app continuou saindo ciano — este teste fixava o
  // valor ANTIGO e por isso passou verde enquanto a identidade sumia. Agora ele
  // fixa o default novo E prova que o ciano sobreviveu como paleta legada: as
  // duas metades do contrato que a regressao quebrou.
  it("uses the indigo operational accent and layered neutral surfaces", () => {
    applyUiTheme("nexus-dark");
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--accent")).toBe("#7c86ff");
    expect(root.getPropertyValue("--bg")).toBe("#0b0b0c");
    expect(root.getPropertyValue("--bg-elevated")).toBe("#141416");
  });

  it("keeps the pre-0.21 cyan available as an explicit legacy palette", () => {
    expect(LEGACY_NEXUS_CYAN_PALETTE.accent).toBe("#3dd9ff");
    applyUiTheme("nexus-dark");
    expect(document.documentElement.style.getPropertyValue("--accent")).not.toBe(
      LEGACY_NEXUS_CYAN_PALETTE.accent,
    );
  });

  it("keeps the solid accent ink at WCAG AA contrast over the accent", () => {
    applyUiTheme("nexus-dark");
    const root = document.documentElement.style;
    expect(
      contrast(root.getPropertyValue("--accent-ink"), root.getPropertyValue("--accent")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps secondary text at >=5:1 over both surface levels", () => {
    applyUiTheme("nexus-dark");
    const root = document.documentElement.style;
    const textDim = root.getPropertyValue("--text-dim");
    expect(
      contrast(textDim, root.getPropertyValue("--bg")),
    ).toBeGreaterThanOrEqual(5);
    expect(
      contrast(textDim, root.getPropertyValue("--bg-elevated")),
    ).toBeGreaterThanOrEqual(5);
  });
});

describe("--text-faint holds AA in EVERY theme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.platform;
  });

  const themes: TerminalThemeId[] = [
    "nexus-dark",
    "nexus-light",
    "dracula",
    "solarized-dark",
  ];

  it.each(themes)(
    "%s: third-level text stays >=4.5:1 over --bg and --bg-elevated",
    (themeId) => {
      // The palette is applied inline by applyUiTheme; --text-faint lives only
      // in CSS, so the two sources have to be crossed to see the real pair.
      applyUiTheme(themeId);
      const root = document.documentElement.style;
      const faint = tokenForTheme(themeId, "--text-faint");

      expect(faint).toMatch(/^#[0-9a-f]{6}$/i);
      expect(
        contrast(faint, root.getPropertyValue("--bg")),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(faint, root.getPropertyValue("--bg-elevated")),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(themes)("%s: faint stays dimmer than --text-dim", (themeId) => {
    applyUiTheme(themeId);
    const root = document.documentElement.style;
    const surface = root.getPropertyValue("--bg-elevated");
    const faint = tokenForTheme(themeId, "--text-faint");
    const dim = root.getPropertyValue("--text-dim");

    expect(contrast(faint, surface)).toBeLessThan(contrast(dim, surface));
  });
});

describe("token discipline — 0.21 CTA and pixel-grid campaign", () => {
  it("the file editor Save button speaks the primary CTA tokens", () => {
    const save = ruleBody(panelsCss, ".files-editor__save");
    expect(save).toContain("background: var(--btn-primary)");
    expect(save).toContain("color: var(--btn-primary-ink)");
    expect(save).not.toContain("var(--accent)");
    expect(panelsCss).toContain("--btn-primary-hover");
  });

  it("the toast action is a discreet secondary, not a second primary CTA", () => {
    const action = ruleBody(panelsCss, ".toast__action");
    expect(action).toContain("background: transparent");
    expect(action).toContain("color: var(--text)");
    expect(action).not.toContain("var(--btn-primary)");
    expect(action).not.toContain("background: var(--accent)");
  });

  it("the pixel grid is dead in the default and alive in pixel mode only", () => {
    expect(ruleBody(baseCss, ":root")).toContain("--pixel-grid: transparent");
    expect(ruleBody(baseCss, "[data-theme-pixel='on']")).toMatch(
      /--pixel-grid:\s*color-mix\([^;]*var\(--accent\)/,
    );
  });

  it("the settings drawer draws both grid lines from the token", () => {
    const drawer = ruleBody(settingsCss, ".settings__drawer");
    expect(drawer).not.toMatch(/rgba\(/);
    expect(drawer.match(/var\(--pixel-grid\)/g)).toHaveLength(2);
  });
});
