/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { applyUiTheme } from "./ui-theme";

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
