/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanelBody } from "./ProductPanelBodies";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryPanelBody presentation="full" />));
  return { host, root };
}

describe("MemoryPanelBody — origem e data de cada nota (fatia 5)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        product: {
          memoryList: vi.fn(async () => [
            {
              id: "mem-1",
              title: "Sempre use pnpm",
              body: "Sempre use pnpm neste projeto, nunca npm.",
              kind: "preference",
              source: "trusted:operator-preference",
              createdAt: 1_795_000_000_000,
              updatedAt: 1_795_000_000_000,
            },
            {
              id: "mem-2",
              title: "Nota manual",
              body: "Anotação escrita à mão pelo operador.",
              kind: "note",
              source: null,
              createdAt: 1_795_000_000_000,
              updatedAt: 1_795_000_000_000,
            },
          ]),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nexus");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("mostra a origem (source) e a data de cada nota", async () => {
    const { host } = mount();
    await act(async () => Promise.resolve());

    const items = host.querySelectorAll(".product-pane__item");
    expect(items.length).toBe(2);

    const metas = host.querySelectorAll(".product-pane__meta");
    expect(metas.length).toBe(2);
    expect(metas[0]!.textContent).toContain("trusted:operator-preference");
    expect(metas[0]!.textContent).toContain(
      new Date(1_795_000_000_000).toLocaleDateString("pt-BR"),
    );
    // source null não vira texto "null": só a data.
    expect(metas[1]!.textContent).not.toContain("null");
    expect(metas[1]!.textContent).toContain(
      new Date(1_795_000_000_000).toLocaleDateString("pt-BR"),
    );
  });
});
