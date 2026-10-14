/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalThemeId } from "../../shared/settings-types";
import { applyUiTheme, LEGACY_NEXUS_CYAN_PALETTE, PALETTES } from "./ui-theme";
import { parseVsCodeThemeFile } from "./vscode-theme-import";

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

const PINK_CITY_THEME_ID = "nexus-pink-city" as TerminalThemeId;

function computedRootTokens<const T extends readonly string[]>(
  tokenNames: T,
): Record<T[number], string> {
  const rootStyles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    tokenNames.map((token) => [token, rootStyles.getPropertyValue(token).trim()]),
  ) as Record<T[number], string>;
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

describe("Native form control theme", () => {
  let styles: HTMLStyleElement;

  beforeEach(() => {
    styles = document.createElement("style");
    styles.textContent = baseCss;
    document.head.append(styles);
  });

  afterEach(() => {
    styles.remove();
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.platform;
  });

  it("uses dark native menus before settings load", () => {
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
  });

  it("keeps native menus on the same side as every built-in theme", () => {
    for (const theme of Object.keys(PALETTES) as TerminalThemeId[]) {
      applyUiTheme(theme);
      expect(getComputedStyle(document.documentElement).colorScheme, theme).toBe(
        theme === "nexus-light" ? "light" : "dark",
      );
    }
  });

  it("switches native menus with imported light/dark themes and back", () => {
    for (const [background, expected] of [["#ffffff", "light"], ["#101010", "dark"]]) {
      const imported = parseVsCodeThemeFile({
        name: "Native controls",
        colors: { "editor.background": background },
      });
      applyUiTheme("nexus-dark", imported);
      expect(getComputedStyle(document.documentElement).colorScheme).toBe(expected);
    }
    applyUiTheme("nexus-light");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
    applyUiTheme("nexus-pink-city");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
  });
});

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

describe("Pink City UI palette", () => {
  let mountedBaseStyles: HTMLStyleElement;

  beforeEach(() => {
    mountedBaseStyles = document.createElement("style");
    mountedBaseStyles.textContent = baseCss;
    document.head.append(mountedBaseStyles);
  });

  afterEach(() => {
    mountedBaseStyles.remove();
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.platform;
  });

  it("applies the canonical Pink City tokens to the root", () => {
    applyUiTheme(PINK_CITY_THEME_ID);

    expect(document.documentElement.dataset.theme).toBe("nexus-pink-city");
    expect(
      computedRootTokens([
        "--bg",
        "--bg-elevated",
        "--bg-bar",
        "--text",
        "--text-dim",
        "--accent",
        "--accent-ink",
        "--btn-primary",
        "--btn-primary-ink",
      ] as const),
    ).toEqual({
      "--bg": "#080709",
      "--bg-elevated": "#111013",
      "--bg-bar": "#0d0b0f",
      "--text": "#faf7f9",
      "--text-dim": "#aaa2a8",
      "--accent": "#ff4f8b",
      "--accent-ink": "#080709",
      "--btn-primary": "#faf7f9",
      "--btn-primary-ink": "#080709",
    });
  });

  it("meets WCAG AA for every Pink City text pair on both surfaces", () => {
    applyUiTheme(PINK_CITY_THEME_ID);
    const tokens = computedRootTokens([
      "--bg",
      "--bg-elevated",
      "--text",
      "--text-dim",
      "--text-faint",
      "--accent",
      "--btn-primary",
      "--btn-primary-ink",
    ] as const);

    expect(tokens["--accent"]).toBe("#ff4f8b");
    expect(tokens["--btn-primary"]).toBe("#faf7f9");

    for (const foreground of [
      "--text",
      "--text-dim",
      "--text-faint",
      "--accent",
      "--btn-primary",
    ] as const) {
      expect(tokens[foreground]).toMatch(/^#[0-9a-f]{6}$/i);
      for (const background of ["--bg", "--bg-elevated"] as const) {
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    expect(
      contrast(tokens["--btn-primary-ink"], tokens["--btn-primary"]),
      "--btn-primary-ink on --btn-primary",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("restores the current neutral and indigo palette when Nexus Dark is selected", () => {
    applyUiTheme(PINK_CITY_THEME_ID);
    applyUiTheme("nexus-dark");

    expect(document.documentElement.dataset.theme).toBe("nexus-dark");
    expect(
      computedRootTokens([
        "--bg",
        "--bg-elevated",
        "--bg-bar",
        "--text",
        "--text-dim",
        "--text-faint",
        "--accent",
        "--accent-ink",
        "--btn-primary",
        "--btn-primary-ink",
      ] as const),
    ).toEqual({
      "--bg": "#0b0b0c",
      "--bg-elevated": "#141416",
      "--bg-bar": "#101012",
      "--text": "#fafafa",
      "--text-dim": "#a1a1a1",
      "--text-faint": "#8f8f8f",
      "--accent": "#7c86ff",
      "--accent-ink": "#0b0b0c",
      "--btn-primary": "#fafafa",
      "--btn-primary-ink": "#0b0b0c",
    });
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

});
