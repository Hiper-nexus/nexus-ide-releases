import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mission } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  buildGuidedMissionTaskDetail,
  guidedQualityGateDetail,
  GUIDED_SEALED_TASK_DETAIL_MAX_CHARS,
} from "./guided-mission-prompt";
import {
  DESIGN_SYSTEM_CANDIDATE_PATHS,
  MAX_DESIGN_SYSTEM_CHARS,
  resolveWorkspaceDesignContract,
} from "./design-system-reader";
import {
  DEFAULT_DESIGN_TARGET_PATH,
  ROOT_DESIGN_CONTRACT_PATH,
} from "./design-system-authority";
import { DESIGN_CONTRACT_TARGET_PATH } from "../context/design-contract-bootstrap";
import {
  DESIGN_SYSTEM_BEGIN,
  DESIGN_SYSTEM_END,
} from "./design-context-format";

const VISUAL_GOAL =
  "Redesenhar a interface do dashboard React com novos tokens de CSS e tipografia";

function visualMission(): Mission {
  const contract = compileIntentContract({
    goal: VISUAL_GOAL,
    acceptanceCriteria: ["A superfície usa os tokens do contrato de design."],
    intentVersion: 1,
    lane: "standard",
  });
  return {
    id: "mission-design-contract",
    title: "Redesenhar dashboard",
    description: contract.goal,
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 1,
    intentContract: { ...contract, approvedAt: 1, dispatchedAt: 2 },
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("the materialized design contract path is the path consumers resolve", () => {
  it("keeps every writer target inside the single resolver candidate list", () => {
    // The bootstrap autopilot materializes DEFAULT_DESIGN_TARGET_PATH and the
    // root convention is authored by hand. Both must be findable by the ONE
    // resolver every consumer asks, or a contract exists that nobody reads.
    expect(DESIGN_SYSTEM_CANDIDATE_PATHS).toContain(DEFAULT_DESIGN_TARGET_PATH);
    expect(DESIGN_SYSTEM_CANDIDATE_PATHS).toContain(ROOT_DESIGN_CONTRACT_PATH);
    expect(DESIGN_CONTRACT_TARGET_PATH).toBe(DEFAULT_DESIGN_TARGET_PATH);
  });

  it("resolves the root convention first and names the path that answered", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-design-resolve-")),
    );
    try {
      fs.mkdirSync(path.join(root, ".context", "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".context", "docs", "design-system.md"),
        "# Materializado\n",
      );
      expect(resolveWorkspaceDesignContract(root)).toEqual({
        path: DEFAULT_DESIGN_TARGET_PATH,
        content: "# Materializado\n",
      });

      fs.writeFileSync(path.join(root, "DESIGN.md"), "# Raiz\n");
      expect(resolveWorkspaceDesignContract(root)).toEqual({
        path: ROOT_DESIGN_CONTRACT_PATH,
        content: "# Raiz\n",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for a workspace with no contract and for no root at all", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-design-empty-")),
    );
    try {
      expect(resolveWorkspaceDesignContract(root)).toBeNull();
      expect(resolveWorkspaceDesignContract(undefined)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("guided UI task detail carries the design contract", () => {
  let root = "";

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guided-design-")),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const contractPath of [".context/docs/design-system.md", "DESIGN.md"]) {
    it(`delivers the bytes and the resolved path when the contract lives at ${contractPath}`, () => {
      const body = `# Contrato\n\n- accent: #3dd9ff\n- fonte: Inter\n<<${contractPath}>>\n`;
      fs.mkdirSync(path.dirname(path.join(root, contractPath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, contractPath), body);

      const detail = buildGuidedMissionTaskDetail(visualMission(), {
        workKind: "visual",
        workspaceRoot: root,
      });

      expect(detail).toContain(DESIGN_SYSTEM_BEGIN);
      expect(detail).toContain(DESIGN_SYSTEM_END);
      expect(detail).toContain(body.trimEnd());
      expect(detail).toContain(`\`${contractPath}\``);
      expect(detail).not.toContain("design_contract_missing");
      expect(detail.length).toBeLessThanOrEqual(
        GUIDED_SEALED_TASK_DETAIL_MAX_CHARS,
      );
    });
  }

  it("carries no fence and no phantom path when the workspace has no contract", () => {
    const detail = buildGuidedMissionTaskDetail(visualMission(), {
      workKind: "visual",
      workspaceRoot: root,
    });

    expect(detail).not.toContain(DESIGN_SYSTEM_BEGIN);
    expect(detail).not.toContain(DESIGN_SYSTEM_END);
    expect(detail).toContain("design_contract_missing");
    // M6: the blocked handoff is mechanically informative — it names the
    // surface and the exact paths Nexus searched, not just a token.
    for (const candidate of DESIGN_SYSTEM_CANDIDATE_PATHS) {
      expect(detail).toContain(candidate);
    }
    expect(detail).toContain("superficie=");
    expect(detail).toContain("caminho_esperado=");
  });

  it("never asks a non-visual task to obey a contract it was not given", () => {
    fs.writeFileSync(path.join(root, "DESIGN.md"), "# Raiz\n");

    const detail = buildGuidedMissionTaskDetail(visualMission(), {
      workKind: "bug",
      workspaceRoot: root,
    });

    expect(detail).not.toContain(DESIGN_SYSTEM_BEGIN);
    expect(detail).not.toContain("design_contract_missing");
  });

  it("degrades to the missing-contract clause when no workspace root is known", () => {
    const detail = buildGuidedMissionTaskDetail(visualMission(), {
      workKind: "visual",
    });

    expect(detail).not.toContain(DESIGN_SYSTEM_BEGIN);
    expect(detail).toContain("design_contract_missing");
  });

  it("truncates an oversized contract instead of blowing the sealed detail budget", () => {
    fs.writeFileSync(
      path.join(root, "DESIGN.md"),
      `# Contrato\n${"tokens ".repeat(20_000)}`,
    );

    const detail = buildGuidedMissionTaskDetail(visualMission(), {
      workKind: "visual",
      workspaceRoot: root,
    });

    expect(detail).toContain(DESIGN_SYSTEM_BEGIN);
    expect(detail).toContain("[truncated]");
    expect(detail.length).toBeLessThan(
      MAX_DESIGN_SYSTEM_CHARS + 8_000,
    );
    expect(detail.length).toBeLessThanOrEqual(
      GUIDED_SEALED_TASK_DETAIL_MAX_CHARS,
    );
  });
});

describe("the guided gate checks the same file the executor was given", () => {
  it("names the resolved contract path in both gate modes", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gate-design-")),
    );
    try {
      fs.mkdirSync(path.join(root, ".context", "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".context", "docs", "design-system.md"),
        "# Contrato\n\n- accent: #3dd9ff\n",
      );
      for (const readOnly of [true, false]) {
        const detail = guidedQualityGateDetail(visualMission(), {
          readOnly,
          workKind: "visual",
          workspaceRoot: root,
        });
        expect(detail).toContain(`\`${DEFAULT_DESIGN_TARGET_PATH}\``);
        expect(detail).toContain(DESIGN_SYSTEM_BEGIN);
        expect(detail).toContain("- accent: #3dd9ff");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells the gate to block with the named surface when no contract exists", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gate-nodesign-")),
    );
    try {
      const detail = guidedQualityGateDetail(visualMission(), {
        readOnly: true,
        workKind: "visual",
        workspaceRoot: root,
      });
      expect(detail).toContain("design_contract_missing");
      expect(detail).not.toContain(DESIGN_SYSTEM_BEGIN);
      for (const candidate of DESIGN_SYSTEM_CANDIDATE_PATHS) {
        expect(detail).toContain(candidate);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
