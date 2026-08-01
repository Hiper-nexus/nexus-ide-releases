/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionComposer } from "./MissionComposer";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

function mount(
  onSubmit: (intent: string) => void,
  inputDisabled = false,
  submitDisabled = false,
): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <MissionComposer
        inputDisabled={inputDisabled}
        submitDisabled={submitDisabled}
        submitLabel="Descrever objetivo"
        submitIcon="mission"
        onSubmit={onSubmit}
        onOpenTerminal={vi.fn()}
      />,
    );
  });
  return host;
}

describe("MissionComposer", () => {
  it("fills a suggested intent and submits it with Enter", () => {
    const onSubmit = vi.fn();
    const host = mount(onSubmit);
    const chip = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Criar uma feature"),
    );
    act(() => chip?.click());

    const textarea = host.querySelector("textarea");
    expect(textarea?.value).toBe("Criar uma feature");
    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });

    expect(onSubmit).toHaveBeenCalledWith("Criar uma feature");
  });

  it("keeps input and suggestions unavailable while the route is not ready", () => {
    const host = mount(vi.fn(), true, false);
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    const chips = [...host.querySelectorAll("button")].filter((button) =>
      button.className.includes("home-deck__intent-chip"),
    );
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((button) => button.disabled)).toBe(true);
  });
});
