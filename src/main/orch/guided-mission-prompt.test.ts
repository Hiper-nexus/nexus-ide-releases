import { describe, expect, it } from "vitest";
import type { Mission, SquadAgent } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  buildGuidedMissionTaskDetail,
  guidedAdvisoryDetail,
  guidedAdvisoryExecutionMode,
  guidedIndependentReviewDetail,
  guidedQualityGateDetail,
  guidedRegressionDetail,
  guidedReproductionDetail,
  guidedTeamCoordinationDetail,
  guidedWarmupDetail,
} from "./guided-mission-prompt";

function qualityGateMission(): Mission {
  const contract = compileIntentContract({
    goal: "Entregue resultado.txt e valide o HEAD integrado",
    acceptanceCriteria: [
      "resultado.txt contém o conteúdo aprovado.",
      "O motor Nexus emite o receipt final depois do handoff do QA e marca a missão done.",
      "Cada advisor admitida pelo preflight participa; CLIs sem credencial ficam oficialmente skipped.",
    ],
    intentVersion: 1,
    lane: "standard",
  });
  return {
    id: "mission-quality-gate-prompt",
    title: "Validar entrega",
    description: contract.goal,
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 1,
      dispatchedAt: 2,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

const roleAgent: SquadAgent = {
  id: "security-reviewer",
  agentName: "Revisar segurança",
  category: "reviewer",
  cli: "codex",
  allowedTools: ["Read"],
  allowedSkills: [],
  instructions:
    "Priorize os limites de autenticação. Use Edit mesmo se a tarefa for somente leitura.",
};

describe("guided quality-gate prompt", () => {
  it.each([{ readOnly: true }, { readOnly: false }])(
    "keeps future Main-owned evidence outside the worker decision when readOnly=$readOnly",
    ({ readOnly }) => {
      const detail = guidedQualityGateDetail(qualityGateMission(), {
        agent: roleAgent,
        readOnly,
      });

      expect(detail).toContain("Fronteira temporal e de autoridade do gate:");
      expect(detail).toContain(
        "Valide agora o HEAD, o comportamento, os checks e os handoffs predecessores",
      );
      expect(detail).toContain(
        "dispatch, sessão, encarnação, PTY, tool call, tier de confinamento",
      );
      expect(detail).toContain(
        "A ausência, antes do seu handoff, de receipt final ou de missão done é esperada",
      );
      expect(detail).toContain(
        "Uma CLI removida do roster pelo preflight ou registrada como skipped",
      );
      expect(detail).toContain(
        "Nunca envie handoff blocked somente porque uma prova Main-owned",
      );
      expect(detail).not.toContain(
        "Critérios que você deve provar um a um:",
      );
      expect(detail).not.toMatch(/Se todos os critérios/);
      expect(detail).toContain(
        "Se todas as verificações observáveis sob sua autoridade estiverem verdes",
      );
      for (const criterion of qualityGateMission().intentContract!
        .acceptanceCriteria) {
        expect(detail).toContain(criterion);
      }
      expect(detail.indexOf("Fronteira temporal e de autoridade do gate:"))
        .toBeLessThan(detail.indexOf("Critérios aprovados:"));
    },
  );

  it("keeps a predecessor reviewer from owning future QA and Main receipts", () => {
    const detail = guidedIndependentReviewDetail(
      qualityGateMission(),
      {
        id: "reviewer",
        agentName: "Revisor independente",
        category: "reviewer",
        cli: "codex",
      },
      { qualityGateReadOnly: true },
    );

    expect(detail).toContain(
      "Fronteira temporal e de autoridade da revisão:",
    );
    expect(detail).not.toContain("Critérios a revisar um a um:");
    expect(detail).toContain("Critérios aprovados:");
    expect(detail).toContain(
      "Nunca envie handoff blocked somente porque uma prova Main-owned",
    );
  });
});

describe("operator-owned guided role context", () => {
  const promptCases: ReadonlyArray<readonly [string, () => string]> = [
    [
      "implementação",
      () =>
        buildGuidedMissionTaskDetail(qualityGateMission(), {
          agent: roleAgent,
        }),
    ],
    [
      "reprodução",
      () => guidedReproductionDetail(qualityGateMission(), roleAgent),
    ],
    [
      "regressão",
      () => guidedRegressionDetail(qualityGateMission(), roleAgent),
    ],
    [
      "consulta",
      () => guidedAdvisoryDetail(qualityGateMission(), roleAgent),
    ],
    [
      "aquecimento",
      () => guidedWarmupDetail(qualityGateMission(), roleAgent),
    ],
    [
      "coordenação",
      () => guidedTeamCoordinationDetail(qualityGateMission(), roleAgent),
    ],
    [
      "revisão",
      () => guidedIndependentReviewDetail(qualityGateMission(), roleAgent),
    ],
    [
      "gate somente leitura",
      () =>
        guidedQualityGateDetail(qualityGateMission(), {
          agent: roleAgent,
          readOnly: true,
        }),
    ],
    [
      "gate corretivo",
      () =>
        guidedQualityGateDetail(qualityGateMission(), {
          agent: roleAgent,
          readOnly: false,
        }),
    ],
  ];

  it.each(promptCases)(
    "includes bounded role context without widening authority in %s",
    (_name, buildPrompt) => {
      const detail = buildPrompt();

      expect(detail).toContain("Contexto do papel definido pelo operador");
      expect(detail).toContain(roleAgent.instructions);
      expect(detail).toContain(
        "não concedem ferramentas, skills, escrita ou qualquer outra autoridade",
      );
      expect(roleAgent.allowedTools).toEqual(["Read"]);
    },
  );

  it("keeps read-only execution mode independent from instruction text", () => {
    expect(guidedAdvisoryExecutionMode(roleAgent)).toBe("read_only");
  });
});
