import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createRealMissionE2ESquadFixture,
  isCurrentProcessRealMissionE2E,
  isCurrentProcessRealMissionProductWizardE2E,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_SQUAD_ID,
  realMissionE2EAcceptanceCriteria,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EOrchestratorCli,
} from "../shared/real-mission-e2e";
import type { Mission } from "../shared/orch-types";
import type { ProjectExecutionScope } from "../shared/types";
import {
  createContextAttestation,
  writeContextAttestation,
} from "./context/context-attestation";
import { getContextWorkflowService } from "./context/context-workflow-registry";
import type { MissionContract } from "./context/contract-compiler";
import { getContextBySession } from "./orch/gate";
import type { ProjectDomainStoreSuite } from "./orch/project-domain-store-registry";
import {
  resolveProductWizardRealMissionE2ESquadBinding,
  type RealMissionE2ESquadBinding,
} from "./real-mission-e2e-fixture";
import { snapshotSquadAuthority } from "./orch/squad-authority-snapshot";

/**
 * Operational PREVC for the packaged release gate.
 *
 * Stages a real context corpus on the disposable scratch repo and freezes a
 * real mission contract. Merge and final review remain on the production
 * CliAutomatedReviewer path; this fixture only owns deterministic context and
 * sensor inputs.
 */

const CONTEXT_DOCS = [
  "project-overview",
  "business-model",
  "domain-glossary",
  "architecture",
  "testing",
] as const;

const REAL_MISSION_E2E_SQUAD_REVISION_HASH = snapshotSquadAuthority(
  createRealMissionE2ESquadFixture(
    realMissionE2EAdvisorSkipClis(),
    realMissionE2EOrchestratorCli(),
  ),
).hash;

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

interface RealMissionE2EContractProfile {
  readonly binding: RealMissionE2ESquadBinding;
  readonly acceptanceCriteria: readonly string[];
  readonly contextPolicy: "minimal" | "on-demand";
}

function realMissionE2EContractProfile(
  mission: Pick<Mission, "squadId">,
): RealMissionE2EContractProfile | null {
  if (mission.squadId === REAL_MISSION_E2E_SQUAD_ID) {
    return {
      binding: {
        squadId: REAL_MISSION_E2E_SQUAD_ID,
        sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
        sourceSquadRevisionHash: REAL_MISSION_E2E_SQUAD_REVISION_HASH,
        squadRevisionHash: REAL_MISSION_E2E_SQUAD_REVISION_HASH,
      },
      acceptanceCriteria: realMissionE2EAcceptanceCriteria(
        realMissionE2EOrchestratorCli(),
      ),
      contextPolicy: "minimal",
    };
  }
  if (
    !isCurrentProcessRealMissionProductWizardE2E() ||
    typeof mission.squadId !== "string"
  ) {
    return null;
  }
  const binding = resolveProductWizardRealMissionE2ESquadBinding(
    mission.squadId,
  );
  return binding
    ? {
        binding,
        acceptanceCriteria:
          REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
        contextPolicy: "on-demand",
      }
    : null;
}

function isExactRealMissionE2EIntent(
  mission: Mission & {
    readonly projectId?: string;
    readonly checkoutId?: string;
  },
  missionId: string,
  scope: ProjectExecutionScope,
): boolean {
  const contract = mission.intentContract;
  const profile = realMissionE2EContractProfile(mission);
  return Boolean(
    profile &&
    mission.id === missionId &&
      mission.projectId === scope.projectId &&
      mission.checkoutId === scope.checkoutId &&
      mission.status === "running" &&
      (mission.intentState === "executing" ||
        mission.intentState === "validating") &&
      mission.orchestratorSessionId &&
      contract &&
      mission.intentVersion === contract.intentVersion &&
      contract.version === 1 &&
      contract.source === "typed" &&
      contract.goal === REAL_MISSION_E2E_GOAL &&
      sameOrderedStrings(
        contract.acceptanceCriteria,
        profile.acceptanceCriteria,
      ) &&
      contract.risk === "normal" &&
      contract.executionMode === "autopilot" &&
      (contract.lane ?? "standard") === "standard" &&
      contract.contextPolicy === profile.contextPolicy &&
      Number.isInteger(contract.approvedAt) &&
      Number.isInteger(contract.dispatchedAt) &&
      contract.squadRevisionHash === profile.binding.squadRevisionHash &&
      contract.orchestratorRuntime?.adapterId === "codex" &&
      contract.orchestratorRuntime.readOnly === false &&
      contract.orchestratorRuntime.nativeReadOnly === true &&
      contract.parentTaskId === undefined &&
      contract.requiredWorkerAgentRef === undefined,
  );
}

function isExactRealMissionE2EFrozenContract(
  contract: MissionContract,
  missionId: string,
  scope: ProjectExecutionScope,
  acceptanceCriteria: readonly string[],
): boolean {
  return (
    contract.projectId === scope.projectId &&
    contract.checkoutId === scope.checkoutId &&
    contract.missionId === missionId &&
    contract.goal === REAL_MISSION_E2E_GOAL &&
    contract.acceptanceCriteria.length === acceptanceCriteria.length &&
    contract.acceptanceCriteria.every(
      (criterion, index) =>
        criterion.id === `ac-${index + 1}` &&
        criterion.statement === acceptanceCriteria[index] &&
        criterion.requiredSensorIds.length === 0 &&
        criterion.invariantRefs.length === 0 &&
        criterion.requiredArtifactIds.length === 0,
    ) &&
    sameOrderedStrings(contract.requiredSensors, ["typecheck", "unit"]) &&
    contract.requiredArtifacts.length === 0 &&
    /^[a-f0-9]{64}$/u.test(contract.contractHash) &&
    contract.contextRevision.length > 0
  );
}

function hasExactRealMissionE2EFrozenWorkflow(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  scope: ProjectExecutionScope,
): boolean {
  if (!isCurrentProcessRealMissionE2E() || !sameScope(suite.scope, scope)) {
    return false;
  }
  const mission = suite.missions.get(missionId);
  const profile = mission ? realMissionE2EContractProfile(mission) : null;
  if (
    !mission ||
    !profile ||
    !isExactRealMissionE2EIntent(mission, missionId, scope) ||
    !suite.missions.hasCurrentKickoffAcceptance(missionId)
  ) {
    return false;
  }
  const current = getContextWorkflowService(scope).getMissionWorkflow(missionId);
  return Boolean(
    current.contract &&
      current.workflow &&
      current.workflow.stage === "execution" &&
      isExactRealMissionE2EFrozenContract(
      current.contract.contract,
      missionId,
      scope,
      profile.acceptanceCriteria,
      ),
  );
}

function sha256File(root: string, relative: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(root, relative)))
    .digest("hex");
}

function writeText(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * Stage a freeze-ready `.context` corpus on the scratch workspace.
 * Caller must commit it with the gate baseline so HEAD history stays 1 commit.
 */
export function stageRealMissionE2EContextCorpus(workspacePath: string): void {
  // Pure filesystem staging — do NOT use workspace-file helpers here: the
  // scratch tree is not yet bound as a product workspace identity.
  for (const relative of [
    ".context/docs",
    ".context/decisions",
    ".context/plans",
    ".context/agents",
    ".context/skills",
    ".context/config",
    ".context/nexus/facts",
    ".context/nexus/invariants",
    ".context/nexus/regressions",
    ".context/nexus/attestations",
    ".context/nexus/evidence",
  ]) {
    fs.mkdirSync(path.join(workspacePath, relative), {
      recursive: true,
      mode: 0o700,
    });
  }

  writeText(
    workspacePath,
    ".context/config/policy.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "enforce",
        protectedPaths: [".context"],
        evidence: {
          trustedProducer: "nexus",
          bind: [
            "projectId",
            "checkoutId",
            "missionId",
            "baseSha",
            "headSha",
            "diffHash",
            "contractHash",
            "contextHash",
            "sensorConfigHash",
          ],
          blockOnSeverities: ["critical", "high"],
        },
        review: {
          requireIndependentAuthor: true,
          // Provider labels are not reviewer identities; the doctor schema
          // requires this list empty. Independence is enforced by author vs
          // reviewer session identity on each attestation, not by risk tags.
          requireDifferentProviderFor: [],
          minimumReviewers: { high: 1, critical: 2 },
        },
      },
      null,
      2,
    )}\n`,
  );

  writeText(
    workspacePath,
    ".context/config/sensors.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sensors: [
          {
            id: "typecheck",
            command: ["/usr/bin/true"],
            timeoutMs: 60_000,
            network: false,
          },
          {
            id: "unit",
            command: ["/usr/bin/true"],
            timeoutMs: 60_000,
            network: false,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  for (const name of CONTEXT_DOCS) {
    writeText(
      workspacePath,
      `.context/docs/${name}.md`,
      `# ${name}\n\nReal-mission release gate context for PREVC freeze.\n`,
    );
  }

  writeText(
    workspacePath,
    ".context/nexus/invariants/core.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        facts: [
          {
            id: "release-gate-result-file",
            statement: "Worker owns resultado.txt exclusively.",
            claimKey: "release.gate.resultado.owned",
            value: true,
            kind: "asserted",
            domains: ["release-gate"],
            relatedSymbols: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  writeText(
    workspacePath,
    "package.json",
    `${JSON.stringify(
      {
        name: "nexus-real-mission-e2e",
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)" --',
        },
      },
      null,
      2,
    )}\n`,
  );
  // Attestations are written later with the real projectId (see seal…Attestations).
}

/**
 * Bind attestations to the live project identity. Must run after the workspace
 * scope is known; files are gitignored so merge keeps a clean primary checkout.
 */
export function sealRealMissionE2EContextAttestations(
  scope: ProjectExecutionScope,
): void {
  const root = scope.rootRealPath;
  for (const targetPath of [
    ...CONTEXT_DOCS.map((name) => `.context/docs/${name}.md`),
    ".context/nexus/invariants/core.json",
  ]) {
    writeContextAttestation(
      scope,
      createContextAttestation(scope, {
        targetPath,
        targetHash: sha256File(root, targetPath),
        sources: [
          {
            type: "file",
            locator: "package.json",
            sourceHash: sha256File(root, "package.json"),
          },
        ],
        author: {
          id: "e2e-context-author",
          sessionId: `author:${targetPath}`,
          provider: "codex",
        },
        reviewer: {
          id: "e2e-context-reviewer",
          sessionId: `reviewer:${targetPath}`,
          provider: "claude",
        },
        reviewedAt: "2026-07-23T00:00:00.000Z",
        nexusVersion: "0.19.27",
      }),
    );
  }
}

export function freezeRealMissionE2EPrevCIfNeeded(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  scope: ProjectExecutionScope,
): { frozen: boolean; reason: string } {
  if (!isCurrentProcessRealMissionE2E()) {
    return { frozen: false, reason: "not-e2e-process" };
  }
  const mission = suite.missions.get(missionId);
  const profile = mission ? realMissionE2EContractProfile(mission) : null;
  if (
    !mission ||
    !profile ||
    !sameScope(suite.scope, scope) ||
    !isExactRealMissionE2EIntent(mission, missionId, scope)
  ) {
    return { frozen: false, reason: "not-e2e-mission" };
  }
  if (!suite.missions.hasCurrentKickoffAcceptance(missionId)) {
    return { frozen: false, reason: "kickoff-pending" };
  }
  if (!mission.orchestratorSessionId) {
    return { frozen: false, reason: "no-orchestrator-session" };
  }

  const orch = getContextBySession(mission.orchestratorSessionId);
  if (!orch || orch.role !== "orchestrator" || orch.missionId !== missionId) {
    return { frozen: false, reason: "gate-context-unavailable" };
  }

  const service = getContextWorkflowService(scope);
  const existing = service.getMissionWorkflow(missionId);
  if (existing.contract || existing.workflow) {
    if (
      existing.contract &&
      existing.workflow?.stage === "execution" &&
      isExactRealMissionE2EFrozenContract(
        existing.contract.contract,
        missionId,
        scope,
        profile.acceptanceCriteria,
      ) &&
      hasExactRealMissionE2EFrozenWorkflow(suite, missionId, scope)
    ) {
      return { frozen: false, reason: "already-frozen" };
    }
    return { frozen: false, reason: "fixture-contract-mismatch" };
  }

  try {
    sealRealMissionE2EContextAttestations(scope);
    service.freezeContract(
      {
        missionId,
        goal: REAL_MISSION_E2E_GOAL,
        acceptanceCriteria: profile.acceptanceCriteria.map(
          (statement, index) => ({
            id: `ac-${index + 1}`,
            statement,
            requiredSensorIds: [],
            invariantRefs: [],
            requiredArtifactIds: [],
          }),
        ),
        requestedSensors: ["typecheck", "unit"],
        riskHints: ["small isolated behavior change"],
      },
      {
        id: orch.agentName ?? "e2e-orchestrator",
        sessionId: orch.sessionId ?? mission.orchestratorSessionId,
        provider: "codex",
      },
    );
    // The production Guided Planner has already sealed all three main-owned
    // worker waves (executor → independent reviewer → corrective QA),
    // so the planning stage of the medium-risk route is satisfied. Advance to
    // execution so the durable scheduler can dispatch executor then QA —
    // without dropping acceptance criteria to weaken the contract.
    service.advance(missionId, "execution");
    if (!hasExactRealMissionE2EFrozenWorkflow(suite, missionId, scope)) {
      throw new Error("frozen PREVC identity diverged from the E2E fixture");
    }
    return { frozen: true, reason: "frozen" };
  } catch (error) {
    return {
      frozen: false,
      reason:
        error instanceof Error
          ? `freeze-failed:${error.message.slice(0, 160)}`
          : "freeze-failed",
    };
  }
}
