import fs from "node:fs";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(new URL("../styles/terminal-setup.css", import.meta.url), "utf8");
/** Sem comentários: eles citam a solução antiga (`calc(100dvh - …)`) de propósito. */
const declared = css.replace(/\/\*[\s\S]*?\*\//g, "");

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("terminal setup — o rodapé nunca é cortado", () => {
  it("centraliza com flex, para o painel ter um content-box definido", () => {
    const rule = cssRule(declared, ".terminal-setup");
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/justify-content:\s*center/);
  });

  it("limita o painel pela altura do container, não pela viewport", () => {
    const rule = cssRule(declared, ".terminal-setup__panel");
    expect(rule).toMatch(/max-height:\s*100%/);
    // `100dvh` desalinha do container real no Electron e empurra o rodapé para fora.
    expect(declared).not.toMatch(/dvh/);
  });

  it("mantém o rodapé fora da área que rola", () => {
    const rule = cssRule(declared, ".terminal-setup__footer");
    expect(rule).toMatch(/flex-shrink:\s*0/);
  });

  it("dá contorno às ações secundárias do rodapé", () => {
    const rule = cssRule(declared, ".terminal-setup__actions .terminal-setup__quiet-button");
    expect(rule).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(rule).not.toMatch(/border-color:\s*transparent/);
  });
});
