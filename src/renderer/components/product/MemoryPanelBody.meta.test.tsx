/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanelBody } from "./ProductPanelBodies";

const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><text>d</text></svg>`,
  })),
}));
vi.mock("mermaid", () => ({ default: mermaidApi }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount(
  presentation: "full" | "compact" = "full",
): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryPanelBody presentation={presentation} />));
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

    const metas = host.querySelectorAll(".product-pane__item .product-pane__meta");
    expect(metas.length).toBe(2);
    expect(metas[0]!.textContent).toContain("preferência do operador");
    expect(metas[0]!.textContent).not.toContain("trusted:");
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

describe("MemoryPanelBody — corpo da nota em markdown (F-1169)", () => {
  const BODY =
    "## Decisão\n\n- usar **pnpm**\n- rodar `pnpm test`\n\n```mermaid\ngraph TD; A-->B\n```\n\n<img src=x onerror=\"window.__pwned = 1\">";

  beforeEach(() => {
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        product: {
          memoryList: vi.fn(async () => [
            {
              id: "mem-md",
              title: "Gerenciador",
              body: BODY,
              kind: "decision",
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
  });

  it("na apresentação completa o corpo sai formatado, com diagrama e sem HTML executável", async () => {
    const { host } = mount("full");
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const body = host.querySelector(".product-pane__item .product-pane__body");
    expect(body).not.toBeNull();
    expect(body!.querySelector("h2")?.textContent).toBe("Decisão");
    expect(body!.querySelector("li strong")?.textContent).toBe("pnpm");
    expect(body!.querySelector("li code")?.textContent).toBe("pnpm test");
    expect(body!.querySelector("figure.markdown-with-mermaid__diagram")).not.toBeNull();
    expect(body!.querySelector("img, script")).toBeNull();
    expect(body!.textContent).toContain('<img src=x onerror="window.__pwned = 1">');
  });

  it("no resumo compacto continua texto curto, sem markdown montado", async () => {
    const { host } = mount("compact");
    await act(async () => Promise.resolve());
    const snip = host.querySelector(".product-pane__item .product-pane__snip");
    expect(snip?.tagName).toBe("P");
    expect(snip?.querySelector("h2, strong, figure")).toBeNull();
  });
});
