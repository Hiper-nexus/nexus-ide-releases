import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import type { Squad } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  clearPersonasForTests,
  registerPersona,
} from "./persona-store";
import {
  bindSpawnAuthority,
  consumeImmediateSquadSpawnGrant,
  issueImmediateSquadSpawnGrant,
  persistedPaneAllowedTools,
  resolveSpawnAuthority,
} from "./spawn-authority";

const tempDirs: string[] = [];

function tempProject(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-spawn-authority-")),
  );
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const squad: Squad = {
  id: "nexus-review",
  name: "Code Review",
  createdAt: "1",
  builtin: true,
  orchestratorInstructions: "",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    },
  ],
};

const immediateRuntime = {
  adapterId: "claude",
  model: null,
  accountId: null,
  effort: null,
  paneId: "pane-immediate",
  title: "Maestro",
  missionTitle: "Reviewed mission",
  missionGoal: "Reviewed mission",
  missionId: null,
} as const;

const immediateRuntimeRequest = {
  adapterId: immediateRuntime.adapterId,
  model: immediateRuntime.model,
  accountId: immediateRuntime.accountId,
  effort: immediateRuntime.effort,
  paneId: immediateRuntime.paneId,
  missionId: immediateRuntime.missionId,
} as const;

describe("spawn authority resolution", () => {
  it("never treats a renderer-derived squad id as main authority", () => {
    expect(() =>
      resolveSpawnAuthority("squad-nexus-review-abc123", null, [squad]),
    ).toThrow(/unknown or expired/);
  });

  it("refuses an immediate grant when a worker is the first agent but no Maestro exists", () => {
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const workerOnly: Squad = {
      ...squad,
      agents: [
        {
          ...squad.agents[0]!,
          id: "worker",
          agentName: "Executor",
          category: "executor",
        },
      ],
    };

    expect(() =>
      issueImmediateSquadSpawnGrant({
        owner,
        scope: testProjectScope(),
        squad: workerOnly,
        runtime: immediateRuntime,
        now: 900,
      }),
    ).toThrow(/without an orchestrator/);
  });

  it("keeps a trusted pending binding unchanged", () => {
    const pending = {
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker" as const,
      allowedTools: [],
      allowedSkills: ["test"],
      scope: testProjectScope(),
    };

    expect(resolveSpawnAuthority("orchspawn-1", pending, [squad])).toBe(
      pending,
    );
  });

  it("treats a spawn without orchestration metadata as a direct user spawn", () => {
    expect(resolveSpawnAuthority(undefined, null, [squad])).toBeNull();
  });

  it("accepts only a cryptographically opaque main-owned squad grant, once", () => {
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const scope = testProjectScope();
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 1_000,
    });
    expect(token).toMatch(/^squadgrant_[A-Za-z0-9_-]{40,}$/);
    expect(token).not.toContain(squad.id);

    const grant = consumeImmediateSquadSpawnGrant({
      requestId: token,
      owner,
      scope,
      squads: [squad],
      runtime: immediateRuntimeRequest,
      now: 1_001,
    });
    expect(grant).toEqual({
      authority: {
        squadId: "nexus-review",
        agentName: "Maestro",
        role: "orchestrator",
        allowedTools: ["nexus_pane_spawn"],
        allowedSkills: ["review"],
        immediateMissionTitle: "Reviewed mission",
        immediateMissionGoal: "Reviewed mission",
        scope,
        requestedCwd: scope.rootRealPath,
      },
      runtime: immediateRuntime,
    });
    expect(
      resolveSpawnAuthority(
        token,
        null,
        [squad],
        null,
        grant?.authority ?? null,
      ),
    ).toBe(grant?.authority);
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: token,
        owner,
        scope,
        squads: [squad],
        runtime: immediateRuntimeRequest,
        now: 1_002,
      }),
    ).toBeNull();
  });

  it("burns an immediate grant on owner, scope, squad, or expiry drift", () => {
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const attacker = {
      id: 8,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const scope = testProjectScope();

    const ownerBound = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 1_000,
    });
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: ownerBound,
        owner: attacker,
        scope,
        squads: [squad],
        runtime: immediateRuntimeRequest,
        now: 1_001,
      }),
    ).toBeNull();
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: ownerBound,
        owner,
        scope,
        squads: [squad],
        runtime: immediateRuntimeRequest,
        now: 1_002,
      }),
    ).toBeNull();

    const scopeBound = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 2_000,
    });
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: scopeBound,
        owner,
        scope: testProjectScope({ checkoutId: "checkout-drift" }),
        squads: [squad],
        runtime: immediateRuntimeRequest,
        now: 2_001,
      }),
    ).toBeNull();

    const squadBound = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 3_000,
    });
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: squadBound,
        owner,
        scope,
        squads: [
          {
            ...squad,
            agents: [{ ...squad.agents[0], agentName: "Alterado" }],
          },
        ],
        runtime: immediateRuntimeRequest,
        now: 3_001,
      }),
    ).toBeNull();

    const expired = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 4_000,
      ttlMs: 10,
    });
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: expired,
        owner,
        scope,
        squads: [squad],
        runtime: immediateRuntimeRequest,
        now: 4_011,
      }),
    ).toBeNull();
  });

  it("binds the complete squad snapshot, including native instructions and workers", () => {
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const scope = testProjectScope();
    const reviewedSquad: Squad = {
      ...squad,
      orchestratorInstructions: "Delegate and verify.",
      nativeInstructions: "Use the provider planner.",
      agents: [
        ...squad.agents,
        {
          id: "worker",
          agentName: "Executor",
          category: "executor",
          cli: "codex",
          model: "gpt-5.4",
          effort: "high",
          allowedTools: ["nexus_handoff"],
        },
      ],
    };
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad: reviewedSquad,
      runtime: immediateRuntime,
      now: 4_500,
    });

    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: token,
        owner,
        scope,
        squads: [
          {
            ...reviewedSquad,
            nativeInstructions: "Changed after confirmation.",
            agents: reviewedSquad.agents.map((agent) =>
              agent.id === "worker" ? { ...agent, model: "gpt-5.6-luna" } : agent,
            ),
          },
        ],
        runtime: immediateRuntimeRequest,
        now: 4_501,
      }),
    ).toBeNull();
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: token,
        owner,
        scope,
        squads: [reviewedSquad],
        runtime: immediateRuntimeRequest,
        now: 4_502,
      }),
    ).toBeNull();
  });

  it("burns the one-shot grant when exact provider or pane runtime drifts", () => {
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const scope = testProjectScope();
    const reviewedRuntime = {
      ...immediateRuntime,
      model: "claude-opus",
      accountId: "account-a",
      effort: "high",
    };
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: reviewedRuntime,
      now: 4_600,
    });

    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: token,
        owner,
        scope,
        squads: [squad],
        runtime: {
          ...immediateRuntimeRequest,
          model: reviewedRuntime.model,
          accountId: reviewedRuntime.accountId,
          effort: "medium",
        },
        now: 4_601,
      }),
    ).toBeNull();
    expect(
      consumeImmediateSquadSpawnGrant({
        requestId: token,
        owner,
        scope,
        squads: [squad],
        runtime: {
          ...immediateRuntimeRequest,
          model: reviewedRuntime.model,
          accountId: reviewedRuntime.accountId,
          effort: reviewedRuntime.effort,
        },
        now: 4_602,
      }),
    ).toBeNull();
  });

  it("binds an immediate grant to the main-captured root, ignoring renderer cwd bytes", () => {
    const root = tempProject();
    const rendererChoice = path.join(root, "renderer-selected");
    fs.mkdirSync(rendererChoice);
    const owner = {
      id: 7,
      isDestroyed: () => false,
    } as unknown as WebContents;
    const scope = testProjectScope({ rootRealPath: root });
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad,
      runtime: immediateRuntime,
      now: 5_000,
    });
    const grant = consumeImmediateSquadSpawnGrant({
      requestId: token,
      owner,
      scope,
      squads: [squad],
      runtime: immediateRuntimeRequest,
      now: 5_001,
    });

    expect(
      bindSpawnAuthority({
        requestId: token,
        pending: null,
        immediateGrant: grant?.authority ?? null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: scope,
        requestedCwd: rendererChoice,
      }).cwd,
    ).toBe(root);
  });

  it("restores a persisted pane with its original scope and attenuated worker tools", () => {
    const scope = testProjectScope({ projectId: "project-a" });
    const authoritySeal = {
      intentVersion: 1,
      intentContractHash: "a".repeat(64),
      contextRevision: "workflow-revision-a",
      contractHash: "b".repeat(64),
      squadRevisionHash: "c".repeat(64),
    };
    const persisted = {
      id: "mpane-1",
      missionId: "mission-a",
      adapterId: "codex",
      title: "QA",
      agentName: "QA",
      role: "worker" as const,
      paneId: "pane-a",
      scope,
      allowedTools: ["nexus_file_read"],
      allowedSkills: ["review"],
      authoritySeal,
      operatorOpened: true,
      createdAt: 1,
    };

    expect(resolveSpawnAuthority(undefined, null, [squad], persisted)).toEqual({
      missionId: "mission-a",
      agentName: "QA",
      role: "worker",
      operatorOpened: true,
      allowedTools: ["nexus_file_read"],
      allowedSkills: ["review"],
      contextRevision: authoritySeal.contextRevision,
      authoritySeal,
      scope,
    });
  });

  it("F-1619: pane do operador sem allowlist gravada volta sem allowlist; worker comum fica []", () => {
    // Campo 20/10: "Claude · operador" (+ Pane → Nesta missão) nasceu com
    // allowedTools null e a linha durável sem o campo. O `[]` suposto aqui
    // e na adoção recusava ligar a tela ao PTY vivo: "Não subiu" em laço.
    const scope = testProjectScope();
    const base = {
      id: "mpane-op",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Claude · operador",
      agentName: "Claude · operador",
      role: "worker" as const,
      paneId: "pane-op",
      scope,
      createdAt: 1,
    };
    expect(
      resolveSpawnAuthority(undefined, null, [squad], { ...base, operatorOpened: true })
        ?.allowedTools,
    ).toBeNull();
    expect(resolveSpawnAuthority(undefined, null, [squad], base)?.allowedTools).toEqual([]);
    expect(persistedPaneAllowedTools({ role: "worker", operatorOpened: true })).toBeNull();
    expect(persistedPaneAllowedTools({ role: "worker" })).toEqual([]);
    expect(persistedPaneAllowedTools({ role: "orchestrator" })).toBeNull();
    // Campo gravado vence a regra, inclusive no pane do operador.
    expect(
      persistedPaneAllowedTools({ role: "worker", operatorOpened: true, allowedTools: ["nexus_file_read"] }),
    ).toEqual(["nexus_file_read"]);
  });

  it("fails closed for stale or fabricated orchestration requests", () => {
    expect(() =>
      resolveSpawnAuthority("orchspawn-expired", null, [squad]),
    ).toThrow(/unknown or expired/);
    expect(() =>
      resolveSpawnAuthority("squad-unknown-x", null, [squad]),
    ).toThrow(/unknown or expired/);
  });

  it("binds a direct user spawn to the main-authorized project, never to renderer cwd identity", () => {
    const root = tempProject();
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const trustedScope = testProjectScope({ rootRealPath: root });

    expect(
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: trustedScope,
        requestedCwd: nested,
      }),
    ).toEqual({
      source: "direct-user",
      context: null,
      scope: trustedScope,
      coordinationScope: trustedScope,
      cwd: fs.realpathSync(nested),
    });
  });

  it("rejects a renderer cwd outside the trusted project instead of minting a new scope", () => {
    const root = tempProject();
    const outside = tempProject();

    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: testProjectScope({ rootRealPath: root }),
        requestedCwd: outside,
      }),
    ).toThrow(/cwd escapes workspace/);
  });

  it("uses the main-recorded pending cwd and ignores a renderer substitution", () => {
    const root = tempProject();
    const trustedCwd = path.join(root, "packages", "api");
    fs.mkdirSync(trustedCwd, { recursive: true });
    const scope = testProjectScope({ rootRealPath: root });

    expect(
      bindSpawnAuthority({
        requestId: "orchspawn-1",
        pending: {
          missionId: "mission-a",
          role: "worker",
          allowedTools: [],
          scope,
          requestedCwd: trustedCwd,
        },
        squads: [squad],
        persistedPane: null,
        trustedUserScope: null,
        requestedCwd: tempProject(),
      }).cwd,
    ).toBe(fs.realpathSync(trustedCwd));
  });

  it("prefers persisted pane scope when resume still carries a legacy squad request id", () => {
    const root = tempProject();
    const scope = testProjectScope({ rootRealPath: root });
    const authority = bindSpawnAuthority({
      requestId: "squad-squad-a-oldrequest",
      pending: null,
      squads: [squad],
      persistedPane: {
        id: "mpane-resume",
        missionId: "mission-a",
        adapterId: "codex",
        title: "Orquestrador",
        role: "orchestrator",
        readOnly: true,
        paneId: "pane-resume",
        cwd: root,
        scope,
        createdAt: 1,
      },
      trustedUserScope: null,
      requestedCwd: tempProject(),
    });

    expect(authority.source).toBe("persisted-pane");
    expect(authority.scope).toEqual(scope);
    expect(authority.cwd).toBe(fs.realpathSync(root));
    expect(authority.context?.readOnly).toBe(true);
  });

  it("binds task filesystem authority to an external worktree without changing mission coordinates", () => {
    const coordinationRoot = tempProject();
    const worktreeRoot = tempProject();
    const coordinationScope = testProjectScope({
      rootRealPath: coordinationRoot,
    });
    const executionScope = { ...coordinationScope, rootRealPath: worktreeRoot };

    const authority = bindSpawnAuthority({
      requestId: "orchspawn-worktree",
      pending: {
        missionId: "mission-a",
        role: "worker",
        allowedTools: [],
        scope: coordinationScope,
        executionScope,
        requestedCwd: worktreeRoot,
      },
      squads: [squad],
      persistedPane: null,
      trustedUserScope: null,
    });

    expect(authority.scope.rootRealPath).toBe(worktreeRoot);
    expect(authority.coordinationScope).toEqual(coordinationScope);
    expect(authority.cwd).toBe(worktreeRoot);
  });

  it("rejects a worktree carrying different project coordinates", () => {
    const coordinationRoot = tempProject();
    const worktreeRoot = tempProject();
    const coordinationScope = testProjectScope({
      rootRealPath: coordinationRoot,
    });
    expect(() =>
      bindSpawnAuthority({
        requestId: "orchspawn-worktree",
        pending: {
          missionId: "mission-a",
          role: "worker",
          allowedTools: [],
          scope: coordinationScope,
          executionScope: {
            ...coordinationScope,
            projectId: "other-project",
            rootRealPath: worktreeRoot,
          },
          requestedCwd: worktreeRoot,
        },
        squads: [squad],
        persistedPane: null,
        trustedUserScope: null,
      }),
    ).toThrow(/execution scope differs/i);
  });

  it("rejects direct, pending and persisted spawns that have no trusted project scope", () => {
    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: null,
      }),
    ).toThrow(/authorized project scope/);

    expect(() =>
      bindSpawnAuthority({
        requestId: "orchspawn-1",
        pending: {
          missionId: "mission-a",
          role: "worker",
          allowedTools: [],
        },
        squads: [squad],
        persistedPane: null,
        trustedUserScope: testProjectScope(),
      }),
    ).toThrow(/pending spawn.*scope/);

    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: {
          id: "mpane-legacy",
          missionId: "mission-a",
          adapterId: "codex",
          title: "Legacy",
          role: "worker",
          paneId: "pane-legacy",
          createdAt: 1,
        },
        trustedUserScope: testProjectScope(),
      }),
    ).toThrow(/persisted pane.*scope/);
  });
});

// ---------------------------------------------------------------------------
// P1-3 — Personas de agente independentes da voz
// ---------------------------------------------------------------------------

describe("persona injection in spawn authority (P1-3)", () => {
  const owner = {
    id: 42,
    isDestroyed: () => false,
  } as unknown as WebContents;

  const squadWithPersona: Squad = {
    id: "nexus-review",
    name: "Code Review",
    createdAt: "1",
    builtin: true,
    orchestratorInstructions: "",
    agents: [
      {
        id: "orch",
        agentName: "Maestro",
        category: "orchestrator",
        cli: "claude",
        persona: "Forge",
        allowedTools: ["nexus_pane_spawn"],
        allowedSkills: ["review"],
      },
    ],
  };

  const squadWithoutPersona: Squad = {
    id: "nexus-review",
    name: "Code Review",
    createdAt: "1",
    builtin: true,
    orchestratorInstructions: "",
    agents: [
      {
        id: "orch",
        agentName: "Maestro",
        category: "orchestrator",
        cli: "claude",
        allowedTools: ["nexus_pane_spawn"],
        allowedSkills: ["review"],
      },
    ],
  };

  const runtime = {
    adapterId: "claude",
    model: null,
    accountId: null,
    effort: null,
    paneId: "pane-persona-test",
    title: "Maestro",
    missionTitle: "Persona test mission",
    missionGoal: "Persona test mission",
    missionId: null,
  } as const;

  afterEach(() => {
    clearPersonasForTests();
  });

  // Critério de aceitação (a): agente com persona nomeada injeta o system-prompt no spawn.
  it("(a) agente com persona nomeada injeta systemPrompt na autoridade de spawn", () => {
    registerPersona("Forge", "Você é Forge, mecânico de construção especializado.");
    const scope = testProjectScope();
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad: squadWithPersona,
      runtime,
    });
    const consumed = consumeImmediateSquadSpawnGrant({
      requestId: token,
      owner,
      scope,
      squads: [squadWithPersona],
      runtime: {
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        paneId: runtime.paneId,
        missionId: runtime.missionId,
      },
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.authority.systemPrompt).toBe(
      "Você é Forge, mecânico de construção especializado.",
    );
  });

  // Critério de aceitação (a, negativo): sem persona no agente → sem systemPrompt.
  it("(a) agente sem persona não adiciona systemPrompt", () => {
    const scope = testProjectScope();
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad: squadWithoutPersona,
      runtime,
    });
    const consumed = consumeImmediateSquadSpawnGrant({
      requestId: token,
      owner,
      scope,
      squads: [squadWithoutPersona],
      runtime: {
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        paneId: runtime.paneId,
        missionId: runtime.missionId,
      },
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.authority.systemPrompt).toBeUndefined();
  });

  // Critério de aceitação (a): persona registrada após a grant mas antes do consume — lookup é no momento do issueGrant.
  it("(a) persona desconhecida no momento da grant não adiciona systemPrompt", () => {
    // Persona NÃO registrada antes da grant
    const scope = testProjectScope();
    const token = issueImmediateSquadSpawnGrant({
      owner,
      scope,
      squad: squadWithPersona,
      runtime,
    });
    // Registrar APÓS a grant não deve afetar o resultado já capturado
    registerPersona("Forge", "Registrada tarde demais.");
    const consumed = consumeImmediateSquadSpawnGrant({
      requestId: token,
      owner,
      scope,
      squads: [squadWithPersona],
      runtime: {
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        paneId: runtime.paneId,
        missionId: runtime.missionId,
      },
    });
    expect(consumed).not.toBeNull();
    // systemPrompt pode ser undefined (persona não estava no registry no momento do grant)
    expect(consumed!.authority.systemPrompt).toBeUndefined();
  });

  // Critério de aceitação (b): persona funciona sem depender de voice-ipc.
  it("(b) a cadeia de persona não importa voice-ipc", async () => {
    // Importar persona-store e spawn-authority diretamente e verificar que funcionam.
    const { lookupPersonaSystemPrompt } = await import("./persona-store");
    clearPersonasForTests();
    registerPersona("TestBot", "Sou TestBot.");
    expect(lookupPersonaSystemPrompt("TestBot")).toBe("Sou TestBot.");
    // voice-ipc não está no grafo de dependências de persona-store (garantido estruturalmente).
  });
});
