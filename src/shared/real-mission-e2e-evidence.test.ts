import { describe, expect, it } from "vitest";

import {
  REAL_MISSION_E2E_CTA,
  parseRealMissionE2EEvidence,
  realMissionE2EAcceptanceCriteria,
} from "./real-mission-e2e";
import { sha, validPassEvidence } from "./real-mission-e2e-test-support";

describe("real mission E2E PASS graph", () => {
  it("parses a complete PASS receipt", () => {
    expect(parseRealMissionE2EEvidence(validPassEvidence()).status).toBe(
      "pass",
    );
  });

  it("accepts scheduler-owned delivery, which stamps no acceptance deadline", () => {
    // Entrega scheduler-owned (topologias `delivery` e `wave-pack`, que
    // anunciam `no_manual_ack_required=true` desde 67a7e8a7) não abre janela de
    // ack manual: o ack físico É a aceitação, então o produto insere a
    // tentativa já em `accepted` sem carimbar `acceptDeadlineAt`
    // (handoff-physical-ack-authority.ts). O prazo é uma extensão Nexus do
    // caminho de paste manual, não parte do contrato de handoff.
    const schedulerOwned = validPassEvidence();
    for (const handoff of schedulerOwned.handoffs as Array<
      Record<string, unknown>
    >) {
      for (const attempt of handoff.deliveryAttempts as Array<
        Record<string, unknown>
      >) {
        if (attempt.state !== "accepted") continue;
        attempt.acceptDeadlineAt = null;
        attempt.acceptedAt = attempt.startedAt;
      }
    }

    expect(parseRealMissionE2EEvidence(schedulerOwned).status).toBe("pass");
  });

  it("still enforces the acceptance deadline whenever the product stamps one", () => {
    const lateAccept = validPassEvidence();
    const handoff = (
      lateAccept.handoffs as Array<Record<string, unknown>>
    )[0]!;
    const accepted = (
      handoff.deliveryAttempts as Array<Record<string, unknown>>
    ).find((attempt) => attempt.state === "accepted")!;
    accepted.acceptDeadlineAt = (accepted.acceptedAt as number) - 1;

    expect(() => parseRealMissionE2EEvidence(lateAccept)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the AGY advisor handoff to use its authenticated mission shim", () => {
    const physicalAgy = validPassEvidence();
    const dispatch = (
      physicalAgy.dispatches as Array<Record<string, unknown>>
    ).find((candidate) => candidate.agentRef === "e2e-advisor-agy")!;
    const handoff = (
      physicalAgy.handoffs as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === dispatch.handoffId)!;
    const physicalReceipt = handoff.physicalReceipt as Record<string, unknown>;
    const auditIntent = handoff.auditIntent as Record<string, unknown>;
    physicalReceipt.source = "mission-shim";
    auditIntent.source = "mission-shim";

    expect(parseRealMissionE2EEvidence(physicalAgy).status).toBe("pass");

    const forgedHttpAgy = validPassEvidence();
    const forgedDispatch = (
      forgedHttpAgy.dispatches as Array<Record<string, unknown>>
    ).find((candidate) => candidate.agentRef === "e2e-advisor-agy")!;
    const forgedHandoff = (
      forgedHttpAgy.handoffs as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === forgedDispatch.handoffId)!;
    (forgedHandoff.physicalReceipt as Record<string, unknown>).source =
      "http-mcp";
    (forgedHandoff.auditIntent as Record<string, unknown>).source = "http-mcp";
    expect(() => parseRealMissionE2EEvidence(forgedHttpAgy)).toThrow(
      /real-mission invariants/,
    );

    const forgedPtyAgy = validPassEvidence();
    const forgedPtyDispatch = (
      forgedPtyAgy.dispatches as Array<Record<string, unknown>>
    ).find((candidate) => candidate.agentRef === "e2e-advisor-agy")!;
    const forgedPtyHandoff = (
      forgedPtyAgy.handoffs as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === forgedPtyDispatch.handoffId)!;
    (forgedPtyHandoff.physicalReceipt as Record<string, unknown>).source =
      "pty-stream";
    (forgedPtyHandoff.auditIntent as Record<string, unknown>).source =
      "pty-stream";
    expect(() => parseRealMissionE2EEvidence(forgedPtyAgy)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects PTY-stream handoffs from every non-AGY worker", () => {
    const forgedExecutor = validPassEvidence();
    const dispatch = (
      forgedExecutor.dispatches as Array<Record<string, unknown>>
    ).find((candidate) => candidate.agentRef === "e2e-executor")!;
    const handoff = (
      forgedExecutor.handoffs as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === dispatch.handoffId)!;
    const physicalReceipt = handoff.physicalReceipt as Record<string, unknown>;
    const auditIntent = handoff.auditIntent as Record<string, unknown>;
    physicalReceipt.source = "pty-stream";
    auditIntent.source = "pty-stream";

    expect(() => parseRealMissionE2EEvidence(forgedExecutor)).toThrow(
      /real-mission invariants/,
    );
  });

  it("cannot label the synthetic zero-findings council as review coverage", () => {
    const misleading = validPassEvidence();
    misleading.reviewOrigin = "e2e-merge-review-fixture";

    expect(() => parseRealMissionE2EEvidence(misleading)).toThrow();
  });

  it("rejects the obsolete schema v7 receipt", () => {
    const legacy = validPassEvidence();
    legacy.schemaVersion = 7;
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();
  });

  it("rejects the obsolete schema v8 receipt", () => {
    const legacy = validPassEvidence();
    legacy.schemaVersion = 8;
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();
  });

  it("rejects green evidence without route, handoff, or integration proof", () => {
    const evidence = validPassEvidence();
    evidence.dispatches = [];
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact fan-out roots and sequential review chain", () => {
    const missingQa = validPassEvidence();
    (missingQa.dispatches as unknown[]).pop();
    (missingQa.handoffs as unknown[]).pop();
    (missingQa.panes as unknown[]).pop();
    expect(() => parseRealMissionE2EEvidence(missingQa)).toThrow(
      /real-mission invariants/,
    );

    const serializedRoot = validPassEvidence();
    const serializedDispatches = serializedRoot.dispatches as Array<
      Record<string, unknown>
    >;
    const executor = serializedDispatches.find(
      (dispatch) => dispatch.plannerId === "guided-execution",
    )!;
    const advisory = serializedDispatches.find(
      (dispatch) =>
        typeof dispatch.plannerId === "string" &&
        dispatch.plannerId.startsWith("guided-advisory-"),
    )!;
    executor.dependsOn = [advisory.taskId];
    expect(() => parseRealMissionE2EEvidence(serializedRoot)).toThrow(
      /real-mission invariants/,
    );

    const detachedReview = validPassEvidence();
    const detachedDispatches = detachedReview.dispatches as Array<
      Record<string, unknown>
    >;
    detachedDispatches.find(
      (dispatch) =>
        dispatch.plannerId === "guided-review-1-e2e-reviewer",
    )!.dependsOn = [];
    expect(() => parseRealMissionE2EEvidence(detachedReview)).toThrow(
      /real-mission invariants/,
    );
  });

  it("binds an independent advisor HEAD to the executor integration chronology", () => {
    const withAdvisorHead = (
      head: string,
      noChangeHead = head,
      issuedAt?: number,
    ): Record<string, unknown> => {
      const evidence = validPassEvidence();
      const dispatch = (
        evidence.dispatches as Array<Record<string, unknown>>
      ).find(
        (candidate) =>
          candidate.plannerId === "guided-advisory-1-e2e-advisor-kimi",
      )!;
      const handoff = (
        evidence.handoffs as Array<Record<string, unknown>>
      ).find((candidate) => candidate.id === dispatch.handoffId)!;
      const receipt = dispatch.integrationReceipt as Record<string, unknown>;
      const physicalReceipt = handoff.physicalReceipt as Record<
        string,
        unknown
      >;
      const cleanDiff = String(receipt.reference).split(":").at(-1);

      physicalReceipt.worktreeHeadSha = head;
      receipt.reference = `no-change:${noChangeHead}:${cleanDiff}`;
      if (issuedAt !== undefined) {
        const acceptedAttempt = (
          handoff.deliveryAttempts as Array<Record<string, unknown>>
        )[0]!;
        const participation = (
          evidence.participation as Array<Record<string, unknown>>
        ).find((row) => row.cli === "kimi")!;
        physicalReceipt.issuedAt = issuedAt;
        acceptedAttempt.startedAt = issuedAt;
        acceptedAttempt.acceptedAt = issuedAt;
        acceptedAttempt.acceptDeadlineAt = issuedAt + 1;
        handoff.consumedAt = issuedAt + 1;
        dispatch.handoffAcceptedAt = issuedAt;
        dispatch.completedAt = issuedAt + 1;
        receipt.completedAt = issuedAt + 1;
        participation.handoffAt = issuedAt;
      }
      return evidence;
    };
    const baseline = validPassEvidence();
    const repository = baseline.repository as Record<string, unknown>;
    const initialHead = repository.initialHeadSha as string;
    const finalHead = repository.finalHeadSha as string;
    const executorCompletedAt = (
      baseline.dispatches as Array<Record<string, unknown>>
    ).find((dispatch) => dispatch.plannerId === "guided-execution")!
      .completedAt as number;

    expect(() =>
      parseRealMissionE2EEvidence(withAdvisorHead(finalHead)),
    ).toThrow(/real-mission invariants/);
    expect(
      parseRealMissionE2EEvidence(
        withAdvisorHead(finalHead, finalHead, executorCompletedAt),
      ).status,
    ).toBe("pass");
    // Mundo same_checkout (gate 0.28.0): o head capturado prova O QUE o
    // leitor observou, não QUANDO submeteu — um advisor paralelo observa a
    // árvore PRÉ-entrega e legitimamente entrega DEPOIS do receipt do
    // executor. Head inicial é sempre plausível; só ver o head FINAL antes
    // de o executor concluir continua impossível (asserção acima).
    expect(
      parseRealMissionE2EEvidence(
        withAdvisorHead(
          initialHead,
          initialHead,
          executorCompletedAt + 1,
        ),
      ).status,
    ).toBe("pass");

    const unknownHead = "c".repeat(40);
    expect(() =>
      parseRealMissionE2EEvidence(withAdvisorHead(unknownHead)),
    ).toThrow(/real-mission invariants/);
    expect(() =>
      parseRealMissionE2EEvidence(
        withAdvisorHead(finalHead, "a".repeat(40)),
      ),
    ).toThrow(/real-mission invariants/);
  });

  it("rejects durable rows that never came from a physical worker PTY", () => {
    const evidence = validPassEvidence();
    const worker = (evidence.panes as Array<Record<string, unknown>>)[1];
    worker.ptySpawnedAt = null;
    worker.ptyDataAt = null;
    worker.ptyChunkSha256 = null;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact physical mutation authority for every runtime role", () => {
    expect(
      (validPassEvidence().panes as Array<Record<string, unknown>>).map(
        (pane) => pane.nativeReadOnly,
      ),
    ).toEqual([false, false, false, false]);

    const mutations = [
      [0, "readOnly", true],
      [0, "nativeReadOnly", true],
      [1, "readOnly", true],
      [1, "nativeReadOnly", true],
      [2, "readOnly", false],
      [2, "nativeReadOnly", true],
      [3, "readOnly", false],
      [3, "nativeReadOnly", true],
    ] as const;

    for (const [paneIndex, field, value] of mutations) {
      const evidence = validPassEvidence();
      const pane = (evidence.panes as Array<Record<string, unknown>>)[
        paneIndex
      ]!;
      pane[field] = value;
      expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
        /real-mission invariants/,
      );
    }
  });

  it("rejects a durable handoff omitted from the projected proof set", () => {
    const evidence = validPassEvidence();
    const durableHandoffs = evidence.durableHandoffs as {
      count: number;
      ids: string[];
    };
    durableHandoffs.count = 4;
    durableHandoffs.ids.push("handoff-orphan");

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects an observed physical PTY omitted from the pane proof set", () => {
    const evidence = validPassEvidence();
    const physicalPty = evidence.physicalPty as {
      count: number;
      ids: string[];
    };
    physicalPty.count = 5;
    physicalPty.ids.push("session-orphan-retry");

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects direct store rows without the exact MCP provenance receipt", () => {
    const evidence = validPassEvidence();
    (evidence.handoffs as Array<Record<string, unknown>>)[0].physicalReceipt =
      null;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );

    const afterIntegration = validPassEvidence();
    const provenance = (
      afterIntegration.handoffs as Array<Record<string, unknown>>
    )[0].physicalReceipt as Record<string, unknown>;
    provenance.issuedAt = 31;
    expect(() => parseRealMissionE2EEvidence(afterIntegration)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact correlated HTTP audit intent for each physical receipt", () => {
    const missingAudit = validPassEvidence();
    (missingAudit.handoffs as Array<Record<string, unknown>>)[0].auditIntent =
      null;
    expect(() => parseRealMissionE2EEvidence(missingAudit)).toThrow(
      /real-mission invariants/,
    );

    const wrongInvocation = validPassEvidence();
    const audit = (wrongInvocation.handoffs as Array<Record<string, unknown>>)[0]
      .auditIntent as Record<string, unknown>;
    audit.invocationId = "another-tool-call";
    expect(() => parseRealMissionE2EEvidence(wrongInvocation)).toThrow(
      /real-mission invariants/,
    );
  });

  it("accepts the delivery chain after exact current-session acceptance without manual consumption", () => {
    const evidence = validPassEvidence("product-wizard");
    for (const handoff of evidence.handoffs as Array<
      Record<string, unknown>
    >) {
      handoff.deliveryState = "submitted";
      handoff.consumedAt = null;
      handoff.consumedBySessionId = null;
      handoff.consumedDeliveryAttemptId = null;
    }

    expect(parseRealMissionE2EEvidence(evidence).status).toBe("pass");
  });

  it("rejects partial delivery state, forged consumption or duplicate acceptance", () => {
    const partial = validPassEvidence();
    const partialHandoff = (
      partial.handoffs as Array<Record<string, unknown>>
    )[0]!;
    partialHandoff.deliveryState = "acknowledged";
    partialHandoff.consumedBySessionId = null;
    expect(() => parseRealMissionE2EEvidence(partial)).toThrow(
      /real-mission invariants/,
    );

    const consumedWithoutReceipt = validPassEvidence();
    const consumedHandoff = (
      consumedWithoutReceipt.handoffs as Array<Record<string, unknown>>
    )[0]!;
    consumedHandoff.consumedAt = null;
    consumedHandoff.consumedBySessionId = null;
    consumedHandoff.consumedDeliveryAttemptId = null;
    expect(() => parseRealMissionE2EEvidence(consumedWithoutReceipt)).toThrow(
      /real-mission invariants/,
    );

    const wrongAttempt = validPassEvidence();
    (wrongAttempt.handoffs as Array<Record<string, unknown>>)[0]
      .consumedDeliveryAttemptId = "attempt-forged";
    expect(() => parseRealMissionE2EEvidence(wrongAttempt)).toThrow(
      /real-mission invariants/,
    );

    const duplicateAccepted = validPassEvidence();
    const handoff = (
      duplicateAccepted.handoffs as Array<Record<string, unknown>>
    )[0];
    const attempts = handoff.deliveryAttempts as Array<Record<string, unknown>>;
    attempts.push({
      ...attempts[0],
      id: "attempt-executor-duplicate",
      attemptNo: 2,
    });
    expect(() => parseRealMissionE2EEvidence(duplicateAccepted)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires reviewer consumption of the exact executor dependency receipt", () => {
    const missing = validPassEvidence();
    missing.dependencyConsumptions = [];
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const wrongHash = validPassEvidence();
    (
      wrongHash.dependencyConsumptions as Array<Record<string, unknown>>
    )[0].handoffSummarySha256 = sha("forged-summary");
    expect(() => parseRealMissionE2EEvidence(wrongHash)).toThrow(
      /real-mission invariants/,
    );
  });

  it("requires the exact main-owned Mission Driver PREVC completion proof", () => {
    const missing = validPassEvidence();
    missing.completion = null;
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const forged = validPassEvidence();
    const forgedWorkflow = (forged.completion as Record<string, unknown>)
      .workflow as Record<string, unknown>;
    const forgedBinding = forgedWorkflow.binding as Record<string, unknown>;
    forgedBinding.contractHash = sha("forged-contract");
    expect(() => parseRealMissionE2EEvidence(forged)).toThrow(
      /real-mission invariants/,
    );

    const legacy = validPassEvidence();
    legacy.completion = {
      origin: "main-verified-task-plan",
      marker: "legacy text marker",
    };
    expect(() => parseRealMissionE2EEvidence(legacy)).toThrow();

    const failedDriver = validPassEvidence();
    const driver = (
      failedDriver.completion as {
        driver: Record<string, unknown>;
      }
    ).driver;
    driver.lastOutcome = "failed";
    expect(() => parseRealMissionE2EEvidence(failedDriver)).toThrow();

    const missingReceipt = validPassEvidence();
    (
      missingReceipt.completion as {
        stepReceipts: unknown[];
      }
    ).stepReceipts.pop();
    expect(() => parseRealMissionE2EEvidence(missingReceipt)).toThrow(
      /real-mission invariants/,
    );
  });

});

describe("real mission E2E v9 advisor participation", () => {
  it("requires the participation array in the strict envelope", () => {
    const evidence = validPassEvidence();
    delete evidence.participation;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow();
  });

  it("requires every credentialed advisor to prove PTY, nexus_* tool and handoff", () => {
    const missing = validPassEvidence();
    (missing.participation as Array<Record<string, unknown>>)[1]!.handoffAt =
      null;
    expect(() => parseRealMissionE2EEvidence(missing)).toThrow(
      /real-mission invariants/,
    );

    const forged = validPassEvidence();
    (forged.participation as Array<Record<string, unknown>>)[0]!.handoffAt =
      999;
    expect(() => parseRealMissionE2EEvidence(forged)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects a mislabeled confinement tier or an out-of-order roster", () => {
    const wrongTier = validPassEvidence();
    (wrongTier.participation as Array<Record<string, unknown>>)[1]!.tier =
      "mechanically-confined";
    expect(() => parseRealMissionE2EEvidence(wrongTier)).toThrow(
      /canonical harness roster/,
    );

    const reordered = validPassEvidence();
    const rows = reordered.participation as Array<Record<string, unknown>>;
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    expect(() => parseRealMissionE2EEvidence(reordered)).toThrow(
      /canonical harness roster/,
    );
  });

  it("passes with env-skipped advisors inside and outside the fan-out groups", () => {
    expect(() =>
      parseRealMissionE2EEvidence(
        validPassEvidence("private-runner", {
          skipAdvisorClis: ["kimi", "opencode"],
        }),
      ),
    ).not.toThrow();

    // Sem nenhuma advisor credenciada a cadeia codex v8 continua exata.
    const codexOnly = validPassEvidence("private-runner", {
      skipAdvisorClis: [
        "kimi",
        "agy",
        "opencode",
        "claude",
        "glm",
      ],
    });
    const parsed = parseRealMissionE2EEvidence(codexOnly);
    expect(parsed.status).toBe("pass");
    expect(parsed.plan?.tasks).toHaveLength(3);
    expect(parsed.dispatches).toHaveLength(3);
    expect(parsed.handoffs).toHaveLength(3);
    expect(parsed.dependencyConsumptions).toHaveLength(2);
    expect(
      parsed.participation.every((row) => row.skipped === "no-credential"),
    ).toBe(true);
  });

  it("accepts the immutable runtime squad lineage in a private diagnostic", () => {
    const evidence = validPassEvidence("private-runner", {
      skipAdvisorClis: [
        "kimi",
        "agy",
        "opencode",
        "claude",
        "glm",
      ],
    });
    const runtimeSquadId =
      "agentic-runtime-11111111-1111-4111-8111-111111111111";
    const runtimeHash = sha("private-runtime-squad");
    const mission = evidence.mission as Record<string, unknown>;
    const plan = evidence.plan as Record<string, unknown>;
    mission.squadId = runtimeSquadId;
    mission.squadRevisionHash = runtimeHash;
    plan.squadId = runtimeSquadId;

    const parsed = parseRealMissionE2EEvidence(evidence);
    expect(parsed.mission?.squadId).toBe(runtimeSquadId);
    expect(parsed.mission?.squadSourceId).toBe(
      "agentic-nexus-real-mission-e2e",
    );
    expect(parsed.mission?.squadSourceRevisionHash).not.toBe(runtimeHash);
  });

  it("rejects a private runtime squad without the canonical source lineage", () => {
    const evidence = validPassEvidence("private-runner");
    const runtimeSquadId =
      "agentic-runtime-22222222-2222-4222-8222-222222222222";
    const mission = evidence.mission as Record<string, unknown>;
    const plan = evidence.plan as Record<string, unknown>;
    mission.squadId = runtimeSquadId;
    mission.squadSourceId = "agentic-forged-source";
    mission.squadRevisionHash = sha("private-runtime-squad");
    plan.squadId = runtimeSquadId;

    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /agentic-nexus-real-mission-e2e|missionIdentity|real-mission invariants/,
    );
  });

  it("rejects PASS evidence whose skipped advisor still executed", () => {
    const evidence = validPassEvidence("private-runner", {
      skipAdvisorClis: ["kimi"],
    });
    const rows = evidence.participation as Array<Record<string, unknown>>;
    rows[1]!.spawnedAt = 100;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /canonical harness roster|real-mission invariants/,
    );
  });

  it("accepts advisor-absent as a closed failure code", () => {
    const evidence = validPassEvidence();
    evidence.status = "fail";
    evidence.failure = {
      code: "advisor-absent",
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: "done",
        paneCount: 4,
        dispatchCount: 9,
        handoffCount: 8,
      },
    };
    expect(parseRealMissionE2EEvidence(evidence).failure?.code).toBe(
      "advisor-absent",
    );
  });

  it("accepts a named domain block as a closed failure reason", () => {
    const evidence = validPassEvidence();
    evidence.status = "fail";
    evidence.failure = {
      code: "mission-blocked",
      reason: "dispatch-failed",
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: "blocked",
        paneCount: 1,
        dispatchCount: 0,
        handoffCount: 0,
      },
    };

    expect(parseRealMissionE2EEvidence(evidence).failure?.reason).toBe(
      "dispatch-failed",
    );
  });

  it("closes product-wizard FAIL evidence without the causal wizard receipt", () => {
    // O wizard nunca executou (timeout/setup): o FAIL fecha com receipt nulo
    // em vez de derrubar o processo com ZodError no attester.
    const evidence = validPassEvidence("product-wizard");
    evidence.status = "fail";
    evidence.wizardCoverage = "not-covered";
    evidence.wizardReceipt = null;
    evidence.failure = {
      code: "timeout",
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: null,
        paneCount: 0,
        dispatchCount: 0,
        handoffCount: 0,
      },
    };
    const parsed = parseRealMissionE2EEvidence(evidence);
    expect(parsed.status).toBe("fail");
    expect(parsed.failure?.code).toBe("timeout");

    // No PASS, a cadeia causal continua obrigatória.
    const forgedPass = validPassEvidence("product-wizard");
    forgedPass.wizardCoverage = "not-covered";
    forgedPass.wizardReceipt = null;
    expect(() => parseRealMissionE2EEvidence(forgedPass)).toThrow(
      /causal main-owned receipt|real-mission invariants/i,
    );
  });
});

describe("real mission E2E v9 claude orchestrator variant", () => {
  it("parses the claude-orchestrator PASS evidence with the reserved advisor", () => {
    const parsed = parseRealMissionE2EEvidence(
      validPassEvidence("private-runner", { orchestratorCli: "claude" }),
    );

    expect(parsed.status).toBe("pass");
    // Sem advisor Claude: 5 advisors + executor + revisor + QA.
    // 7, não 8: o grok saiu da fixture na 0.28.0 (worker vivo que nunca
    // completa o turno, indiagnosticável sem retenção de scrollback).
    expect(parsed.plan?.tasks).toHaveLength(7);
    expect(parsed.dispatches).toHaveLength(7);
    expect(parsed.handoffs).toHaveLength(7);
    expect(parsed.dependencyConsumptions).toHaveLength(2);
    expect(
      parsed.participation.find((row) => row.cli === "claude")?.skipped,
    ).toBe("orchestrator-reserved");
    expect(parsed.completion?.milestones).toHaveLength(
      realMissionE2EAcceptanceCriteria("claude").length,
    );
    const orchestrator = parsed.panes.find(
      (pane) => pane.role === "orchestrator",
    );
    expect(orchestrator?.adapterId).toBe("claude");
  });

  it("rejects a claude orchestrator whose advisor was not reserved", () => {
    const evidence = validPassEvidence("private-runner", {
      orchestratorCli: "claude",
    });
    (evidence.participation as Array<Record<string, unknown>>).find(
      (row) => row.cli === "claude",
    )!.skipped = "no-credential";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects a codex orchestrator carrying the orchestrator-reserved mark", () => {
    const evidence = validPassEvidence("private-runner", {
      skipAdvisorClis: ["claude"],
    });
    (evidence.participation as Array<Record<string, unknown>>).find(
      (row) => row.cli === "claude",
    )!.skipped = "orchestrator-reserved";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects the codex criteria list on the claude variant run", () => {
    const evidence = validPassEvidence("private-runner", {
      orchestratorCli: "claude",
    });
    // Remove o critério extra da variante: a missão selada tinha 10 marcos.
    const completion = evidence.completion as {
      milestones: unknown[];
      stepReceipts: unknown[];
    };
    completion.milestones.pop();
    completion.stepReceipts.pop();
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it("rejects legacy milestone receipts recorded before confirmation", () => {
    const evidence = validPassEvidence();
    const completion = evidence.completion as {
      stepReceipts: Array<{ fromStage: string }>;
    };
    completion.stepReceipts[0]!.fromStage = "validation-primary";
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });
});
