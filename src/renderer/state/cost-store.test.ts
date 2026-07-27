import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostSnapshot } from "../../shared/cost-types";
import { setActiveWorkspacePath } from "./active-workspace";
import { EMPTY_COST_SNAPSHOT, useCostStore } from "./cost-store";
import { useWorkspaceStore } from "./workspace-store";

const snapshotFixture: CostSnapshot = {
  totalUsd: 1.25,
  perMinuteUsd: 0.02,
  tokPerSec: 40,
  panes: [
    {
      paneId: "p1",
      sessionId: "s1",
      adapterId: "claude",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 1.25,
      paused: false,
    },
  ],
};

function stubCostApi(
  overrides: Partial<{
    snapshot: () => Promise<CostSnapshot>;
    setCap: (
      paneId: string,
      capUsd: number | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (cb: (snapshot: CostSnapshot) => void) => () => void;
  }> = {},
) {
  const api = {
    snapshot: async () => snapshotFixture,
    setCap: async () => ({ ok: true }),
    onChanged: () => () => undefined,
    ...overrides,
  };
  // @ts-expect-error narrow preload test double
  globalThis.window = { nexus: { cost: api } };
  return api;
}

describe("useCostStore preload bridge", () => {
  beforeEach(() => {
    useCostStore.getState().reset();
    setActiveWorkspacePath("/tmp/ws-cost");
    useWorkspaceStore.setState({
      hydrated: true,
      current: { path: "/tmp/ws-cost" } as never,
    });
    // @ts-expect-error explicit stale-preload fixture
    globalThis.window = { nexus: undefined };
  });

  it("hydrates the main-process snapshot through the typed bridge", async () => {
    stubCostApi();
    await useCostStore.getState().hydrate("/tmp/ws-cost");
    expect(useCostStore.getState().snapshot).toEqual(snapshotFixture);
  });

  it("receives main-process change events", () => {
    let listener: ((snapshot: CostSnapshot) => void) | undefined;
    const api = stubCostApi({
      onChanged: (cb) => {
        listener = cb;
        return () => undefined;
      },
    });
    api.onChanged((snapshot) => useCostStore.getState().receive(snapshot));

    const next = { ...snapshotFixture, totalUsd: 2.5 };
    if (!listener) throw new Error("onChanged did not register a listener");
    listener(next);
    expect(useCostStore.getState().snapshot.totalUsd).toBe(2.5);
  });

  it("delegates cost-cap changes to the bridge", async () => {
    const setCap = vi.fn(async () => ({ ok: true }));
    stubCostApi({ setCap });
    await expect(useCostStore.getState().setCap("p1", 5)).resolves.toEqual({
      ok: true,
    });
    expect(setCap).toHaveBeenCalledWith("p1", 5);
  });

  it("returns an explicit unavailable state instead of a silent no-op", async () => {
    await expect(useCostStore.getState().setCap("p1", 5)).resolves.toEqual({
      ok: false,
      error: "cost bridge not wired",
    });
    await useCostStore.getState().hydrate("/tmp/ws-cost");
    expect(useCostStore.getState().snapshot).toEqual(EMPTY_COST_SNAPSHOT);
  });
});
