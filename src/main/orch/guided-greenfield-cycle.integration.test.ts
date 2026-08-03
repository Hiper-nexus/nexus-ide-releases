import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../persistence/settings-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../persistence/settings-store")>();
  return {
    ...actual,
    getOrchSettings: () => ({
      ...actual.getOrchSettings(),
      fastPath: false,
    }),
  };
});

import { compileIntentContract } from "../../shared/mission-intent";
import type { AdapterInfo } from "../../shared/adapter-types";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  runContextBootstrapAutopilot,
} from "../context/context-bootstrap-autopilot";
import {
  inspectContextAttestations,
} from "../context/context-attestation";
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
  getContextWorkflowService,
} from "../context/context-workflow-registry";
import {
  __resetProjectOrientationServiceForTests,
  configureProjectOrientationService,
  ProjectOrientationService,
} from "../context/orientation/orientation-service";
import {
  buildContextBootstrapProposals,
  isMechanicallyReviewableBootstrapProposal,
} from "../context/orientation/orientation-bootstrap-context";
import { ProcessGitRunner } from "../runtime/git-command";
import { ensureGuidedGitBaseline } from "../runtime/guided-greenfield-baseline";
import { GUIDED_GREENFIELD_BRIEF_PATH } from "../runtime/guided-greenfield-brief";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  configureWorktreeRuntimeRegistry,
  disposeWorktreeRuntimeRegistry,
} from "../runtime/worktree-runtime-registry";
import {
  ensureGuidedMissionPlan,
  listRepositoryOwnershipClaims,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import {
  ensureGuidedMissionPrevc,
  ensureGuidedMissionPrevcForScope,
} from "./guided-mission-prevc";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from "./project-domain-store-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { snapshotTaskPlanRoster } from "./task-store";
import { selectPhysicalPlanHandoff } from "./plan-promotion-authority";
import {
  commitPromotedPlanToGit,
  resolvePromotedPlanGitSource,
} from "./promoted-plan-git-authority";

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function freshDirectory(prefix: string): string {
  const value = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  roots.push(value);
  return value;
}

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: "installation-greenfield-cycle",
    projectId: "project-greenfield-cycle",
    checkoutId: "checkout-greenfield-cycle",
    rootRealPath: root,
    identitySource: "manifest",
  });
}

const squad: Squad = {
  id: "agentic-greenfield-cycle",
  name: "Greenfield cycle",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene pelo Nexus.",
  agents: [
    {
      id: "maestro",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
    },
    {
      id: "builder",
      agentName: "Builder",
      category: "executor",
      cli: "codex",
      model: "codex-test",
    },
    {
      id: "quality",
      agentName: "Quality",
      category: "reviewer",
      cli: "codex",
      model: "codex-test",
    },
  ],
};

function adapterInfo(id: string): AdapterInfo {
  const codex = id === "codex";
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: "",
    models: { list: [`${id}-test`], default: `${id}-test` },
    installed: true,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: codex,
    autonomousWorkspaceWriteCapable: codex,
    orchestrationEvidence: codex ? "verified" : "unsupported",
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: codex,
      governedWriter: codex,
      verifiedMaestro: codex,
    },
  };
}

function promotedPlanFromPhysicalHandoff(input: {
  goal: string;
  acceptanceCriteria: readonly string[];
  summary: string;
}) {
  const contract = compileIntentContract({
    goal: input.goal,
    acceptanceCriteria: [...input.acceptanceCriteria],
    intentVersion: 1,
    source: "typed",
    lane: "plan",
  });
  const planMission: Mission = {
    id: "mission-physical-plan",
    title: "PRD físico",
    description: contract.goal,
    status: "running",
    squadId: squad.id,
    milestones: [],
    learnings: "",
    orchestratorSessionId: "plan-session-v1",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
    },
    createdAt: 1,
    updatedAt: 10,
  };
  const handoff: Handoff = {
    id: "handoff-physical-plan",
    missionId: planMission.id,
    sessionId: "plan-session-v1",
    fromAgent: "Maestro",
    authorityOrigin: "agent",
    mcpProvenance: {
      receiptId: "receipt-physical-plan",
      toolCallId: "tool-physical-plan",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      missionId: planMission.id,
      sessionId: "plan-session-v1",
      authoritySha256: "a".repeat(64),
      issuedAt: 20,
    },
    status: "success",
    claimTrust: "untrusted",
    summary: input.summary,
    artifacts: [{ path: "plan.md", kind: "prd" }],
    evidenceIds: [],
    evidenceTrust: "unverified",
    delivered: true,
    deliveryState: "consumed",
    submittedAt: 21,
    acknowledgedAt: 22,
    consumedAt: 23,
    createdAt: 20,
  };
  return selectPhysicalPlanHandoff({
    mission: planMission,
    handoffs: {
      list: () => [handoff],
      get: () => handoff,
    },
  });
}

afterEach(() => {
  __resetProjectOrientationServiceForTests();
  disposeContextWorkflowRegistry();
  disposeProjectDomainStoreRegistry();
  disposeWorktreeRuntimeRegistry();
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("guided physically empty workspace cycle", () => {
  it("seals plan, commits exact brief, reaches Doctor ready, freezes and prepares execution without a provider reviewer", async () => {
    const root = freshDirectory("nexus-guided-empty-cycle-");
    const runtimeRoot = freshDirectory("nexus-guided-empty-runtime-");
    const cacheRoot = freshDirectory("nexus-guided-empty-map-");
    const scope = scopeFor(root);
    const manager = new ProjectRuntimeManager({
      baseDir: runtimeRoot,
      appVersion: "greenfield-cycle-test",
    });
    managers.push(manager);
    let generatedId = 0;
    configureContextWorkflowRegistry(manager, {
      appVersion: "greenfield-cycle-test",
      makeId: () => `greenfield-id-${++generatedId}`,
      now: () => 1_700_000_000_000 + generatedId,
    });
    const domainRegistry = configureProjectDomainStoreRegistry(manager);
    const worktreeRegistry = configureWorktreeRuntimeRegistry(manager);
    const suite = domainRegistry.forScope(scope);
    const approved = compileIntentContract({
      goal: "Entregar um fluxo inicial fiel ao pedido aprovado",
      acceptanceCriteria: [
        "O fluxo aprovado funciona de ponta a ponta",
        "A entrega possui verificação reproduzível",
      ],
      intentVersion: 1,
      source: "typed",
      lane: "standard",
    });
    const mission = suite.missions.create({
      title: "Primeiro produto",
      description: approved.goal,
      squadId: squad.id,
      intentState: "ready_to_start",
      intentVersion: 1,
      intentContract: {
        ...approved,
        approvedAt: 1,
        approvalReviewSha256: "a".repeat(64),
        dispatchedAt: undefined,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    const storedPreflight = suite.missions.get(mission.id);
    expect(storedPreflight).toMatchObject({
      status: "pending",
      intentState: "ready_to_start",
      intentContract: {
        approvedAt: 1,
      },
    });
    expect(storedPreflight?.intentContract).not.toHaveProperty(
      "dispatchedAt",
    );

    const plannerDeps: GuidedMissionPlannerDeps = {
      getSquad: (squadId) => (squadId === squad.id ? squad : null),
      getAdapterInfo: (adapterId) => adapterInfo(adapterId),
      listMissionWorktrees: () => [],
      squadCliPolicy: () => "operator-choice",
      listLiveAdapters: () => [
        {
          id: "codex",
          installed: true,
          models: { list: ["codex-test"], default: "codex-test" },
        },
        {
          id: "glm",
          installed: true,
          models: { list: ["glm-test"], default: "glm-test" },
        },
      ],
      listRepositoryOwnership: (projectScope) =>
        listRepositoryOwnershipClaims(projectScope),
      assertStandardSquadReadiness: () => {},
    };
    expect(ensureGuidedMissionPlan(suite, mission.id, plannerDeps)).toMatchObject(
      { applicable: true, sealed: true },
    );
    expect(suite.missions.get(mission.id)).toMatchObject({
      status: "pending",
      intentState: "ready_to_start",
    });
    expect(suite.tasks.listPlannedTasks(mission.id, 1)).not.toHaveLength(0);
    expect(suite.tasks.getPlanReceipt(mission.id, 1)).toMatchObject({
      squadId: squad.id,
      rosterHash: snapshotTaskPlanRoster(squad.agents).hash,
    });
    // Bootstrap immediately re-enters the planner after the approval preflight.
    // The real store receipt must therefore recover on its second read instead
    // of being mistaken for a stale full-squad approval hash.
    expect(ensureGuidedMissionPlan(suite, mission.id, plannerDeps)).toMatchObject(
      {
        applicable: true,
        sealed: false,
        reason: "already-sealed",
      },
    );
    const tamperedSquad: Squad = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.id === "builder"
          ? { ...agent, model: "codex-tampered" }
          : { ...agent },
      ),
    };
    expect(() =>
      ensureGuidedMissionPlan(suite, mission.id, {
        ...plannerDeps,
        getSquad: () => tamperedSquad,
      }),
    ).toThrow(/guided_plan_squad_stale/i);
    const approvedPreflight = suite.missions.get(mission.id);
    if (!approvedPreflight?.intentContract) {
      throw new Error("approved preflight disappeared");
    }
    const dispatched = suite.missions.update(mission.id, {
      status: "running",
      intentState: "dispatched",
      intentContract: {
        ...approvedPreflight.intentContract,
        dispatchedAt: 2,
      },
    });
    expect(dispatched).toMatchObject({
      status: "running",
      intentState: "dispatched",
      intentContract: { dispatchedAt: 2 },
    });
    const sealedOwnership = suite.tasks
      .listPlannedTasks(mission.id, 1)
      .flatMap((planned) => {
        const decoded = decodeTaskScheduleDetail(planned.task.detail);
        return decoded.meta?.ownership.files ?? [];
      });
    expect(sealedOwnership).not.toContain(GUIDED_GREENFIELD_BRIEF_PATH);
    expect(fs.readdirSync(root)).toEqual([]);

    const pending = ensureGuidedMissionPrevc(scope, mission.id);
    expect(pending).toEqual({
      required: true,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    });
    expect(fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH))).toBe(
      true,
    );
    const git = new ProcessGitRunner();
    const briefHead = git
      .run(root, ["rev-parse", "--verify", "HEAD^{commit}"])
      .stdout.trim();
    expect(
      git.run(root, ["show", `HEAD:${GUIDED_GREENFIELD_BRIEF_PATH}`]).stdout,
    ).toBe(
      fs.readFileSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH), "utf8"),
    );
    const mutationProbe = await worktreeRegistry.create({
      scope,
      missionId: "mission-product-mutation-probe",
      taskId: "task-product-mutation-probe",
      workerId: "worker-product-mutation-probe",
      ownership: {
        files: ["src"],
        symbols: [],
        domains: ["guided-implementation"],
      },
    });
    fs.writeFileSync(
      path.join(mutationProbe.worktreePath, GUIDED_GREENFIELD_BRIEF_PATH),
      "malicious worker rewrite\n",
    );
    git.run(mutationProbe.worktreePath, [
      "add",
      "--",
      GUIDED_GREENFIELD_BRIEF_PATH,
    ]);
    git.run(
      mutationProbe.worktreePath,
      [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "attempt to mutate reserved product authority",
        "--",
        GUIDED_GREENFIELD_BRIEF_PATH,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: "Worker",
          GIT_AUTHOR_EMAIL: "worker@localhost",
          GIT_COMMITTER_NAME: "Worker",
          GIT_COMMITTER_EMAIL: "worker@localhost",
        },
      },
    );
    expect(() =>
      worktreeRegistry.prepareIntegration(
        scope,
        mutationProbe.missionId,
        mutationProbe.taskId,
      ),
    ).toThrow(/ownership/i);

    const orientation = configureProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const preProvider = await ensureGuidedMissionPrevcForScope(
      scope,
      mission.id,
    );
    expect(preProvider).toMatchObject({
      required: true,
      frozen: true,
      stage: "execution",
      readyForWorkerDispatch: true,
    });
    expect(
      manager
        .open(scope)
        .db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM mission_contracts WHERE mission_id = ?) AS contracts,
             (SELECT COUNT(*) FROM workflow_states WHERE mission_id = ?) AS workflows`,
        )
        .get(mission.id, mission.id),
    ).toEqual({ contracts: 1, workflows: 1 });
    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).not.toBe(
      briefHead,
    );
    const attestations = inspectContextAttestations(scope);
    expect(attestations.diagnostics).toEqual([]);
    expect(attestations.attestations).toHaveLength(6);
    expect(
      attestations.attestations.every(
        (attestation) =>
          attestation.author.provider === "nexus-main" &&
          attestation.reviewer.provider === "nexus-mechanical-review" &&
          attestation.author.id !== attestation.reviewer.id,
      ),
    ).toBe(true);

    const workflow = getContextWorkflowService(scope);
    expect(workflow.getMissionWorkflow(mission.id).workflow?.stage).toBe(
      "execution",
    );
    expect(
      ensureGuidedMissionPrevc(scope, mission.id),
    ).toMatchObject({
      required: true,
      frozen: true,
      stage: "execution",
      readyForWorkerDispatch: true,
    });

    const stableHead = git.run(root, ["rev-parse", "HEAD"]).stdout.trim();
    const secondDoctor = await runContextBootstrapAutopilot({
      scope,
      missionId: mission.id,
      author: {
        id: "nexus-guided-doctor",
        sessionId: `main:${mission.id}:doctor-retry`,
        provider: "nexus-main",
      },
      selectQuorum: () => null,
      orientation,
      autoCommit: true,
    });
    expect(secondDoctor).toMatchObject({
      phase: "ready",
      commitSha: null,
      readiness: { ready: true },
      proposedDraftIds: [],
      appliedDraftIds: [],
    });
    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(stableHead);
    expect(git.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
  });

  it("promotes committed plan.md into source-bound Doctor authority, reaches readiness and freezes", async () => {
    const root = freshDirectory("nexus-guided-plan-cycle-");
    const runtimeRoot = freshDirectory("nexus-guided-plan-runtime-");
    const cacheRoot = freshDirectory("nexus-guided-plan-map-");
    const scope = scopeFor(root);
    const manager = new ProjectRuntimeManager({
      baseDir: runtimeRoot,
      appVersion: "promoted-plan-cycle-test",
    });
    managers.push(manager);
    let generatedId = 0;
    configureContextWorkflowRegistry(manager, {
      appVersion: "promoted-plan-cycle-test",
      makeId: () => `promoted-plan-id-${++generatedId}`,
      now: () => 1_700_100_000_000 + generatedId,
    });
    const domainRegistry = configureProjectDomainStoreRegistry(manager);
    const suite = domainRegistry.forScope(scope);
    const goal = "Entregar o sistema descrito no PRD aprovado";
    const criteria = [
      "O fluxo principal funciona de ponta a ponta",
      "A entrega possui verificação reproduzível",
    ];
    const summary = [
      "# PRD aprovado",
      "",
      "## Escopo",
      "",
      "Implementar somente o fluxo descrito neste documento.",
      "",
      "## Restrições / critérios não negociáveis",
      "",
      "- Não alterar o objetivo aprovado.",
      "- Toda entrega deve apresentar evidência reproduzível.",
      "- [ ] TODO futuro que não é autoridade.",
      "",
      "## Riscos conhecidos",
      "",
      "Os riscos que não aparecem aqui continuam desconhecidos.",
    ].join("\n");
    const promotedPlan = promotedPlanFromPhysicalHandoff({
      goal,
      acceptanceCriteria: criteria,
      summary,
    });

    const baseline = ensureGuidedGitBaseline(scope);
    fs.writeFileSync(path.join(root, "plan.md"), summary);
    const planCommit = commitPromotedPlanToGit(scope, promotedPlan);
    const resolved = resolvePromotedPlanGitSource(scope, promotedPlan);
    expect(planCommit.headSha).not.toBe(baseline.headSha);
    expect(resolved).toEqual({
      path: "plan.md",
      content: summary,
      sourceHash: promotedPlan.summarySha256,
      headSha: planCommit.headSha,
    });

    const approved = compileIntentContract({
      goal,
      acceptanceCriteria: criteria,
      intentVersion: 2,
      source: "typed",
      lane: "standard",
    });
    const mission = suite.missions.create({
      title: "Execução do PRD promovido",
      description: goal,
      squadId: squad.id,
      intentState: "dispatched",
      intentVersion: 2,
      intentContract: {
        ...approved,
        approvedAt: 30,
        dispatchedAt: 30,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
        promotedPlan,
      },
    });
    suite.missions.update(mission.id, { status: "running" });

    const orientation = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const map = await orientation.ensure(scope, {
      reason: "mcp",
      waitMs: 8_000,
      force: true,
    });
    const sanctionedSource = Object.freeze({
      file: resolved.path,
      content: resolved.content,
      sourceHash: resolved.sourceHash,
      headSha: resolved.headSha,
      approvedIntent: Object.freeze({
        goal,
        acceptanceCriteria: Object.freeze([...criteria]),
      }),
    });
    const proposals = buildContextBootstrapProposals(scope, map, {
      promotedPlanSource: sanctionedSource,
    });
    expect(proposals).toHaveLength(6);
    expect(
      proposals.every((proposal) =>
        isMechanicallyReviewableBootstrapProposal(
          scope,
          proposal,
          { promotedPlanSource: sanctionedSource },
        )),
    ).toBe(true);
    expect(proposals[0]?.content).toContain(summary);
    expect(proposals[0]?.content).toContain(promotedPlan.summarySha256);
    expect(proposals.map((proposal) => proposal.content).join("\n")).not
      .toMatch(/\b(?:React|Node\.js|PostgreSQL|subscription|per-seat)\b/i);
    expect(
      proposals[0]!.content.match(
        /TODO futuro que não é autoridade\./g,
      ),
    ).toHaveLength(1);

    const tamperedProposal = {
      ...proposals[0]!,
      content: `${proposals[0]!.content}\nInvented domain fact.`,
    };
    expect(
      isMechanicallyReviewableBootstrapProposal(
        scope,
        tamperedProposal,
        { promotedPlanSource: sanctionedSource },
      ),
    ).toBe(false);
    expect(
      isMechanicallyReviewableBootstrapProposal(
        scope,
        proposals[0]!,
        {
          promotedPlanSource: {
            ...sanctionedSource,
            approvedIntent: {
              ...sanctionedSource.approvedIntent,
              goal: "tampered intent",
            },
          },
        },
      ),
    ).toBe(false);
    fs.writeFileSync(path.join(root, "plan.md"), `${summary}\ntamper`);
    expect(() =>
      buildContextBootstrapProposals(scope, map, {
        promotedPlanSource: sanctionedSource,
      }),
    ).toThrow(/(?:changed|dirty) before context proposal/i);
    fs.writeFileSync(path.join(root, "plan.md"), summary);

    const doctor = await runContextBootstrapAutopilot({
      scope,
      missionId: mission.id,
      author: {
        id: "nexus-promoted-plan-doctor",
        sessionId: `main:${mission.id}:doctor`,
        provider: "nexus-main",
      },
      selectQuorum: () => null,
      orientation,
      autoCommit: true,
    });
    expect(doctor).toMatchObject({
      phase: "committed",
      quorumAvailable: false,
      readiness: { ready: true, blockers: [] },
      commitSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
    });
    expect(doctor.bootstrapProposals).toHaveLength(6);
    expect(
      doctor.bootstrapProposals.every(
        (proposal) => proposal.mechanicallyReviewable,
      ),
    ).toBe(true);
    const invariant = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          ".context/nexus/invariants/promoted-plan-authority.json",
        ),
        "utf8",
      ),
    );
    expect(invariant.facts).toEqual([
      expect.objectContaining({
        id: "inv:promoted-plan-authority-integrity",
        claimKey: "nexus.authority.promotedPlanSha256",
        value: promotedPlan.summarySha256,
        domains: ["nexus-governance"],
      }),
    ]);

    const workflow = getContextWorkflowService(scope);
    workflow.freezeContract(
      {
        missionId: mission.id,
        goal,
        acceptanceCriteria: criteria.map((statement, index) => ({
          id: `criterion-${String(index + 1).padStart(4, "0")}`,
          statement,
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        })),
      },
      {
        id: "nexus-promoted-plan-preflight",
        sessionId: `main:${mission.id}`,
        provider: "nexus-main",
      },
    );
    expect(workflow.getMissionWorkflow(mission.id).workflow?.stage).toBe(
      "planning",
    );
    fs.writeFileSync(path.join(root, "plan.md"), `${summary}\nlate tamper`);
    await expect(
      runContextBootstrapAutopilot({
        scope,
        missionId: mission.id,
        author: {
          id: "nexus-promoted-plan-doctor",
          sessionId: `main:${mission.id}:doctor-tamper`,
          provider: "nexus-main",
        },
        selectQuorum: () => null,
        orientation,
        autoCommit: true,
      }),
    ).rejects.toThrow(/promoted_plan_(?:file|source)_drift/i);
    fs.writeFileSync(path.join(root, "plan.md"), summary);
    expect(
      new ProcessGitRunner().run(root, ["status", "--porcelain=v1"]).stdout,
    ).toBe("");
  });
});
