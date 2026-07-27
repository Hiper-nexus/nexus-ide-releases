import { describe, expect, it, vi } from "vitest";
import {
  assessStandardSquadReadiness,
  buildSquadRuntimeCliPolicy,
  type SquadRuntimeProviderSnapshot,
} from "./squad-runtime-policy";

function provider(
  adapterId: string,
  overrides: Partial<SquadRuntimeProviderSnapshot> = {},
): SquadRuntimeProviderSnapshot {
  return {
    adapterId,
    enabled: true,
    installed: true,
    adapterLoaded: true,
    guidedHandoffCapable: true,
    autonomousWorkspaceWriteCapable: adapterId === "codex",
    authStrategy: "subscription",
    defaultModel: `${adapterId}/default`,
    ...overrides,
  };
}

describe("buildSquadRuntimeCliPolicy", () => {
  it("requires enabled + installed + authenticated + available account", () => {
    const accountAvailable = vi.fn(
      (adapterId: string) => adapterId !== "cooldown",
    );
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("codex"),
        provider("disabled", { enabled: false }),
        provider("missing", { installed: false }),
        provider("login", { authStrategy: "login-needed" }),
        provider("omp", { authStrategy: "login-needed" }),
        provider("omp-rpc", { authStrategy: "login-needed" }),
        provider("cooldown"),
        provider("shell"),
      ],
      accountAvailable,
    );

    expect([...policy.routableCliIds]).toEqual(["claude", "codex"]);
    expect([...policy.routableWorkerCliIds]).toEqual(["codex"]);
    expect(accountAvailable).not.toHaveBeenCalledWith("disabled");
    expect(accountAvailable).not.toHaveBeenCalledWith("missing");
    expect(accountAvailable).not.toHaveBeenCalledWith("login");
    expect(accountAvailable).not.toHaveBeenCalledWith("omp");
  });

  it("keeps direct legacy CLIs routable but excludes them from guided workers", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("aider", { guidedHandoffCapable: false }),
        provider("codex"),
        provider("kimi"),
        provider("opencode"),
        provider("grok"),
        provider("agy"),
        provider("omp", {
          defaultModel: "anthropic/claude-sonnet-4-6",
          models: ["anthropic/claude-sonnet-4-6"],
          authReadyModels: ["anthropic/claude-sonnet-4-6"],
        }),
      ],
      () => true,
    );

    expect(policy.routableCliIds.has("aider")).toBe(true);
    expect(policy.routableWorkerCliIds.has("aider")).toBe(false);
    expect([...policy.routableWorkerCliIds]).toEqual(["codex"]);
    for (const directOnly of ["kimi", "opencode", "grok", "agy", "omp"]) {
      expect(policy.routableCliIds.has(directOnly)).toBe(true);
      expect(policy.routableWorkerCliIds.has(directOnly)).toBe(false);
    }
  });

  it("does not let a forged capability promote Kimi into a governed mission worker", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("codex"),
        provider("kimi", {
          guidedHandoffCapable: true,
          autonomousWorkspaceWriteCapable: true,
        }),
      ],
      () => true,
    );

    expect(policy.routableCliIds.has("kimi")).toBe(true);
    expect([...policy.routableWorkerCliIds]).toEqual(["codex"]);
  });

  it("fails closed when a provider row has no loaded main-owned adapter", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("codex"),
        provider("persisted-only", { adapterLoaded: false }),
      ],
      () => true,
    );

    expect([...policy.routableCliIds]).toEqual(["codex"]);
    expect([...policy.routableWorkerCliIds]).toEqual(["codex"]);
  });

  it("admits unauthenticated OpenCode only through its exact free default", () => {
    const freePolicy = buildSquadRuntimeCliPolicy(
      [
        provider("opencode", {
          authStrategy: "login-needed",
          defaultModel: "opencode/big-pickle",
        }),
      ],
      () => true,
    );
    expect([...freePolicy.routableCliIds]).toEqual(["opencode"]);
    expect([...freePolicy.credentiallessOnlyCliIds]).toEqual(["opencode"]);
    expect(freePolicy.credentiallessDefaultModelByCliId).toEqual({
      opencode: "opencode/big-pickle",
    });

    for (const defaultModel of [
      "openrouter/openai/gpt-5",
      "opencode/unreviewed-free",
      "other/opencode/big-pickle",
    ]) {
      const blocked = buildSquadRuntimeCliPolicy(
        [
          provider("opencode", {
            authStrategy: "login-needed",
            defaultModel,
          }),
        ],
        () => true,
      );
      expect([...blocked.routableCliIds]).toEqual([]);
    }
  });

  it("does not require an account for exact free OpenCode, but keeps every other model blocked", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("opencode", {
          authStrategy: "login-needed",
          defaultModel: "openrouter/openai/gpt-5",
          models: [
            "openrouter/openai/gpt-5",
            "opencode/big-pickle",
            "opencode/unreviewed-free",
          ],
        }),
      ],
      (adapterId) => adapterId === "claude",
    );
    expect([...policy.routableCliIds]).toEqual(["claude", "opencode"]);
    expect([...policy.credentiallessOnlyCliIds]).toEqual(["opencode"]);
    expect(policy.credentiallessDefaultModelByCliId).toEqual({});

    const base = [{ category: "orchestrator", cli: "claude" }];
    expect(
      assessStandardSquadReadiness(
        [
          ...base,
          {
            category: "executor",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
          {
            category: "reviewer",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
          ],
          policy,
          new Set(["claude"]),
        ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });
    for (const model of [
      "openrouter/openai/gpt-5",
      "opencode/unreviewed-free",
    ]) {
      expect(
        assessStandardSquadReadiness(
          [
            ...base,
            {
              category: "executor",
              cli: "opencode",
              model,
            },
            {
              category: "reviewer",
              cli: "opencode",
              model: "opencode/big-pickle",
            },
          ],
          policy,
          new Set(["claude"]),
        ),
      ).toMatchObject({ ok: false, code: "executor-unavailable" });
    }
  });

  it("downgrades an authenticated but cooling OpenCode pool to free-only", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("opencode", {
          authStrategy: "subscription",
          defaultModel: "openrouter/openai/gpt-5",
          models: [
            "openrouter/openai/gpt-5",
            "opencode/big-pickle",
          ],
        }),
      ],
      () => false,
    );
    expect([...policy.routableCliIds]).toEqual(["opencode"]);
    expect([...policy.credentiallessOnlyCliIds]).toEqual(["opencode"]);
    expect(policy.credentiallessDefaultModelByCliId).toEqual({});
  });

  it("rejects login-needed OMP even when a Nexus account row appears available", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("omp", {
          authStrategy: "login-needed",
          defaultModel: "anthropic/claude-sonnet",
        }),
      ],
      () => true,
    );
    expect([...policy.routableCliIds]).toEqual([]);
    expect([...policy.routableWorkerCliIds]).toEqual([]);
    expect([...policy.credentiallessOnlyCliIds]).toEqual([]);
  });

  it("keeps OMP readiness scoped to the exact authenticated provider/model", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("omp", {
          defaultModel: "anthropic/claude-sonnet-4-6",
          models: [
            "anthropic/claude-sonnet-4-6",
            "openai-codex/gpt-5.5",
            "xai-oauth/grok-4.5",
          ],
          authReadyModels: ["openai-codex/gpt-5.5"],
        }),
      ],
      () => true,
    );

    expect([...policy.routableCliIds]).toEqual(["omp"]);
    expect(policy.authReadyModelsByCliId.omp).toEqual([
      "openai-codex/gpt-5.5",
    ]);
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "omp", model: "openai-codex/gpt-5.5" },
          { category: "executor", cli: "omp", model: "openai-codex/gpt-5.5" },
          { category: "reviewer", cli: "omp", model: "openai-codex/gpt-5.5" },
        ],
        policy,
        new Set(["omp"]),
      ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "omp", model: "openai-codex/gpt-5.5" },
          { category: "executor", cli: "omp", model: "anthropic/claude-sonnet-4-6" },
          { category: "reviewer", cli: "omp", model: "openai-codex/gpt-5.5" },
        ],
        policy,
        new Set(["omp"]),
      ),
    ).toMatchObject({
      ok: false,
      code: "executor-unavailable",
    });
    // Omitting the model cannot silently use an unauthenticated default.
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "omp", model: "openai-codex/gpt-5.5" },
          { category: "executor", cli: "omp" },
          { category: "reviewer", cli: "omp", model: "openai-codex/gpt-5.5" },
        ],
        policy,
        new Set(["omp"]),
      ),
    ).toMatchObject({
      ok: false,
      code: "executor-unavailable",
    });
  });

  it("admits an explicitly selected free model without trusting an external default", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("opencode", {
          authStrategy: "login-needed",
          defaultModel: "openrouter/openai/gpt-5",
          models: [
            "openrouter/openai/gpt-5",
            "opencode/big-pickle",
          ],
        }),
      ],
      () => true,
    );
    expect([...policy.routableCliIds]).toEqual(["claude", "opencode"]);
    expect([...policy.credentiallessOnlyCliIds]).toEqual(["opencode"]);
    expect(policy.credentiallessDefaultModelByCliId).toEqual({});
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          {
            category: "executor",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
          {
            category: "reviewer",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
        ],
        policy,
        new Set(["claude"]),
      ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "opencode" },
          {
            category: "reviewer",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
        ],
        policy,
        new Set(["claude"]),
      ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });
  });

  it("does not restrict OpenCode models after real provider auth exists", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("opencode", {
          authStrategy: "subscription",
          defaultModel: "openrouter/openai/gpt-5",
        }),
      ],
      () => true,
    );
    expect([...policy.routableCliIds]).toEqual(["opencode"]);
    expect([...policy.credentiallessOnlyCliIds]).toEqual([]);
    expect(policy.credentiallessDefaultModelByCliId).toEqual({});
  });
});

describe("assessStandardSquadReadiness", () => {
  const policy = buildSquadRuntimeCliPolicy(
    [provider("claude"), provider("codex"), provider("kimi")],
    () => true,
  );
  const verified = new Set(["claude", "codex"]);

  it("accepts distinct executor/reviewer identities on the same worker CLI", () => {
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "codex" },
        ],
        policy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it("revalidates every unauthenticated OpenCode roster model", () => {
    const opencodePolicy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("opencode", {
          authStrategy: "login-needed",
          defaultModel: "opencode/big-pickle",
        }),
      ],
      () => true,
    );
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          {
            category: "executor",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
          {
            category: "reviewer",
            cli: "opencode",
            model: "opencode/north-mini-code-free",
          },
        ],
        opencodePolicy,
        verified,
      ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });

    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          {
            category: "executor",
            cli: "opencode",
            model: "opencode/big-pickle",
          },
          {
            category: "reviewer",
            cli: "opencode",
            model: "openrouter/openai/gpt-5",
          },
        ],
        opencodePolicy,
        verified,
      ),
    ).toMatchObject({ ok: false, code: "executor-unavailable" });
  });

  it("rejects every guided worker without physical MCP/OMP handoff", () => {
    const legacyPolicy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("codex"),
        provider("aider", { guidedHandoffCapable: false }),
      ],
      () => true,
    );

    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "codex" },
          { category: "scout", cli: "aider" },
        ],
        legacyPolicy,
        verified,
      ),
    ).toMatchObject({
      ok: false,
      code: "worker-unavailable",
      detail: expect.stringMatching(/aider.*handoff físico/i),
    });
  });

  it.each([
    [
      "explicit Maestro",
      [
        { category: "executor", cli: "codex" },
        { category: "reviewer", cli: "kimi" },
      ],
      "maestro-count",
    ],
    [
      "verified Maestro",
      [
        { category: "orchestrator", cli: "kimi" },
        { category: "executor", cli: "codex" },
        { category: "reviewer", cli: "kimi" },
      ],
      "maestro-unverified",
    ],
    [
      "routable non-Claude executor",
      [
        { category: "orchestrator", cli: "claude" },
        { category: "executor", cli: "missing" },
        { category: "reviewer", cli: "kimi" },
      ],
      "executor-unavailable",
    ],
    [
      "routable non-Claude reviewer",
      [
        { category: "orchestrator", cli: "claude" },
        { category: "executor", cli: "codex" },
        { category: "reviewer", cli: "missing" },
      ],
      "reviewer-unavailable",
    ],
    [
      "global Claude reservation",
      [
        { category: "orchestrator", cli: "claude" },
        { category: "executor", cli: "codex" },
        { category: "reviewer", cli: "kimi" },
        { category: "scout", cli: "claude" },
      ],
      "claude-worker",
    ],
  ])("rejects a standard squad without %s", (_label, agents, code) => {
    expect(
      assessStandardSquadReadiness(agents, policy, verified),
    ).toMatchObject({ ok: false, code });
  });
});
