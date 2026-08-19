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
    expect(accountAvailable).not.toHaveBeenCalledWith("login");
  });

  it("keeps direct legacy CLIs routable but excludes them from guided workers", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("aider", { guidedHandoffCapable: false }),
        provider("codex"),
        provider("kimi", { seatAuthReadiness: "present" }),
        provider("opencode"),
        provider("grok"),
        provider("agy"),
      ],
      () => true,
    );

    expect(policy.routableCliIds.has("aider")).toBe(true);
    expect(policy.routableWorkerCliIds.has("aider")).toBe(false);
    expect([...policy.routableWorkerCliIds]).toEqual(["codex"]);
    for (const directOnly of ["kimi", "opencode", "grok", "agy"]) {
      expect(policy.routableCliIds.has(directOnly)).toBe(true);
      expect(policy.routableWorkerCliIds.has(directOnly)).toBe(false);
    }
  });

  it("Kimi sem provider list (file-only) não entra no roster", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [provider("codex"), provider("kimi")],
      () => true,
    );
    expect(policy.routableCliIds.has("codex")).toBe(true);
    expect(policy.routableCliIds.has("kimi")).toBe(false);
    expect(policy.unroutableReasonByCliId?.kimi).toMatch(/incomplete/);
  });

  it("first-wave só senta AuthReadiness=present", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("codex", { seatAuthReadiness: "present" }),
        provider("kimi", { seatAuthReadiness: "incomplete" }),
        provider("longcat", {
          authStrategy: "api-key",
          seatAuthReadiness: "no-credential",
        }),
      ],
      () => true,
    );
    expect(policy.routableCliIds.has("codex")).toBe(true);
    expect(policy.routableCliIds.has("kimi")).toBe(false);
    expect(policy.routableCliIds.has("longcat")).toBe(false);
    expect(policy.unroutableReasonByCliId?.kimi).toMatch(/incomplete/);
  });

  it("under operator-choice promotes handoff-capable CLIs into workers", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("codex"),
        provider("kimi", {
          seatAuthReadiness: "present",
          guidedHandoffCapable: true,
          autonomousWorkspaceWriteCapable: false,
        }),
        provider("agy", {
          guidedHandoffCapable: true,
        }),
      ],
      () => true,
      true,
    );

    expect(policy.routableWorkerCliIds.has("kimi")).toBe(true);
    expect(policy.routableWorkerCliIds.has("agy")).toBe(true);
    expect(policy.routableWorkerCliIds.has("claude")).toBe(false);
  });

  it("does not let a forged capability promote Kimi into a governed mission worker", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        provider("codex"),
        provider("kimi", {
          seatAuthReadiness: "present",
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
    // Doutrina fluxo-por-padrão: a política ainda computa o gating de modelo
    // free (para o catálogo/spawn), mas a PRONTIDÃO do squad não reprova mais
    // por modelo — a CLI é a autoridade do próprio modelo no terminal.
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
    // Doutrina fluxo-por-padrão: prontidão não reprova mais por modelo; a
    // política ainda expõe o catálogo credentialless para o spawn.
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

describe("assessStandardSquadReadiness (doutrina fluxo-por-padrão)", () => {
  // 2026-08-10: o único gate de forma que sobrou é "exatamente um Maestro".
  // Rota/auth/modelo/reserva-Claude deixaram de reprovar o squad no approve —
  // isso derrubava missões reais com `squad_runtime_unavailable:*` mesmo com a
  // ferramenta instalada e logada. A conversa de login vive no terminal do
  // agente; a fronteira física de spawn permanece fail-closed.
  const policy = buildSquadRuntimeCliPolicy(
    [provider("claude"), provider("codex"), provider("kimi")],
    () => true,
  );
  const verified = new Set(["claude", "codex"]);

  it("aceita executor/reviewer distintos na mesma CLI de worker", () => {
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

  it("não reprova mais por modelo credentialless não pré-aprovado", () => {
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
            model: "opencode/north-mini-code-free",
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
    ).toEqual({ ok: true });
  });

  it("não reprova mais um worker sem handoff físico qualificado (só a forma importa)", () => {
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
    ).toEqual({ ok: true });
  });

  it("não reprova mais uma CLI keychain-only lida como login-needed", () => {
    const coldAgyPolicy = buildSquadRuntimeCliPolicy(
      [
        provider("claude"),
        provider("codex"),
        provider("agy", { authStrategy: "login-needed" }),
      ],
      () => true,
    );

    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "codex" },
          { category: "executor", cli: "agy" },
        ],
        coldAgyPolicy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it("não reprova mais por conta gerenciada ausente — a CLI cobra sua própria auth", () => {
    const noAccountPolicy = buildSquadRuntimeCliPolicy(
      [provider("claude"), provider("codex"), provider("kimi")],
      (adapterId) => adapterId !== "kimi",
    );

    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "codex" },
          { category: "executor", cli: "kimi" },
        ],
        noAccountPolicy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it("aceita dois workers Claude — a reserva de sessão vive na fronteira de spawn, não aqui", () => {
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "codex" },
          { category: "scout", cli: "claude" },
        ],
        policy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it("aceita Maestro não-verificado — verificação é opt-in governed, imposta fisicamente", () => {
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "kimi" },
          { category: "executor", cli: "codex" },
          { category: "reviewer", cli: "kimi" },
        ],
        policy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it("aceita executor em CLI não roteável — a rota real é resolvida no dispatch", () => {
    expect(
      assessStandardSquadReadiness(
        [
          { category: "orchestrator", cli: "claude" },
          { category: "executor", cli: "missing" },
          { category: "reviewer", cli: "kimi" },
        ],
        policy,
        verified,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      "zero Maestro",
      [
        { category: "executor", cli: "codex" },
        { category: "reviewer", cli: "kimi" },
      ],
    ],
    [
      "dois Maestros",
      [
        { category: "orchestrator", cli: "claude" },
        { category: "orchestrator", cli: "codex" },
        { category: "executor", cli: "kimi" },
      ],
    ],
  ])("recusa um squad com %s (única regra de forma que sobra)", (_label, agents) => {
    expect(
      assessStandardSquadReadiness(agents, policy, verified),
    ).toMatchObject({ ok: false, code: "maestro-count" });
  });
});
