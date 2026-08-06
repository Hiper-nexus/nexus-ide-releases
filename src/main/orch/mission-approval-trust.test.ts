import { describe, expect, it } from "vitest";

import { missionApprovalTrustIdentityHash } from "./mission-approval-trust";

describe("missionApprovalTrustIdentityHash — identidade estável p/ squads de engine", () => {
  const GRANT = Object.freeze({
    adapterId: "claude",
    model: "claude-opus-5",
    accountId: "acct-volatil-1",
    effort: "xhigh",
    readOnly: false,
    nativeReadOnly: false,
  });

  function engineSquad(patch: Record<string, unknown> = {}) {
    return {
      id: "agentic-runtime-aaaa",
      name: "Execução + QA",
      hash: "hash-regenerado-1",
      runtimeSourceSquadId: "agentic-decomp-1",
      runtimeSourceSquadRevisionHash: "rev-regenerada-1",
      agents: [
        {
          id: "a1",
          agentName: "Executor",
          category: "executor",
          cli: "codex",
          model: null,
          effort: null,
          allowedTools: ["Bash", "Read"],
          allowedSkills: null,
        },
        {
          id: "a2",
          agentName: "Revisor",
          category: "reviewer",
          cli: "grok",
          model: null,
          effort: null,
          allowedTools: null,
          allowedSkills: ["review"],
        },
      ],
      ...patch,
    };
  }

  it("caso de campo 06/08: decomposição re-gerada NÃO muda a identidade", () => {
    // O usuário marcou "não perguntar de novo" às 09:33:50 e o modal voltou:
    // ids e hashes do squad de engine mudam a cada decomposição.
    const first = missionApprovalTrustIdentityHash(engineSquad(), GRANT);
    const regenerated = missionApprovalTrustIdentityHash(
      engineSquad({
        id: "agentic-runtime-bbbb",
        hash: "hash-regenerado-2",
        runtimeSourceSquadId: "agentic-decomp-2",
        runtimeSourceSquadRevisionHash: "rev-regenerada-2",
      }),
      GRANT,
    );
    expect(first).toBe(regenerated);
  });

  it("conta/effort voláteis do grant não mudam a identidade", () => {
    const a = missionApprovalTrustIdentityHash(engineSquad(), GRANT);
    const b = missionApprovalTrustIdentityHash(engineSquad(), {
      ...GRANT,
      accountId: "acct-rotacionada",
      effort: "high",
    });
    expect(a).toBe(b);
  });

  it("mudança MATERIAL muda a identidade: adapter/modelo do grant", () => {
    const base = missionApprovalTrustIdentityHash(engineSquad(), GRANT);
    expect(
      missionApprovalTrustIdentityHash(engineSquad(), {
        ...GRANT,
        model: "outro-modelo",
      }),
    ).not.toBe(base);
  });

  it("mudança MATERIAL muda a identidade: forma do time ou permissões", () => {
    const base = missionApprovalTrustIdentityHash(engineSquad(), GRANT);
    const semRevisor = engineSquad();
    expect(
      missionApprovalTrustIdentityHash(
        { ...semRevisor, agents: semRevisor.agents.slice(0, 1) },
        GRANT,
      ),
    ).not.toBe(base);
    const outrasTools = engineSquad();
    expect(
      missionApprovalTrustIdentityHash(
        {
          ...outrasTools,
          agents: [
            { ...outrasTools.agents[0]!, allowedTools: ["Bash", "Read", "Write"] },
            outrasTools.agents[1]!,
          ],
        },
        GRANT,
      ),
    ).not.toBe(base);
  });

  it("squad SALVO continua usando a revisão de origem (comportamento 664b534f)", () => {
    const saved = engineSquad({
      id: "mission-runtime-cccc",
      runtimeSourceSquadId: "squad-do-usuario",
      runtimeSourceSquadRevisionHash: "rev-estavel-do-usuario",
    });
    expect(missionApprovalTrustIdentityHash(saved, GRANT)).toBe(
      "rev-estavel-do-usuario",
    );
  });
});
