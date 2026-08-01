// Copyright (c) 2026 Lovecast Inc. — MIT License
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = path.resolve(import.meta.dirname, "..");

function source(relativePath: string): string {
  return readFileSync(path.join(RENDERER, relativePath), "utf8");
}

describe("guided mission entrypoints", () => {
  it("routes the primary new-mission actions through the agentic objective flow", () => {
    const app = source("App.tsx");
    const home = source("components/HomeDeck.tsx");
    const workspaceBar = source("components/WorkspaceBar.tsx");
    const missionRail = source("components/MissionRail.tsx");
    const commandPalette = source("components/CommandPalette.tsx");
    const canvas = source("components/CanvasView.tsx");
    const opsBoard = source("components/OpsBoard.tsx");
    const cmdN = app.slice(
      app.indexOf("// ⌘N — nova missão guiada"),
      app.indexOf("// ⌘1-9"),
    );

    expect(cmdN).toContain("e.key.toLowerCase() === 'n' && !e.shiftKey");
    expect(cmdN).toContain("openForAgentic()");
    expect(cmdN).not.toContain("openForMission()");
    expect(home).toContain("<MissionComposer");
    expect(home).toContain("onSubmit={submitObjective}");
    expect(home).toContain("openAgentic(intent.trim())");
    expect(home).toContain("openAgentic();");
    expect(home).not.toContain('className="home-deck__btn"');
    expect(home).not.toContain("openForMission");
    expect(workspaceBar).toMatch(
      /workspace-bar__btn--primary[\s\S]*?onClick=\{\(\) => openAgentic\(\)\}/,
    );
    expect(
      missionRail.match(/onClick=\{\(\) => openAgentic\(\)\}/g),
    ).toHaveLength(1);
    expect(
      commandPalette.match(
        /useMissionWizardStore\.getState\(\)\.openForAgentic\(\)/g,
      ),
    ).toHaveLength(2);
    expect(canvas).not.toContain("Nova missão");
    expect(canvas).not.toContain("useMissionWizardStore");
    expect(opsBoard).toContain(
      "const openWizard = useMissionWizardStore((s) => s.openForAgentic);",
    );
  });

  it("keeps only the explicitly technical squad editor on the generic picker", () => {
    const workspaceBar = source("components/WorkspaceBar.tsx");
    const opsBoard = source("components/OpsBoard.tsx");
    const orchestrationPanel = source("components/OrchestrationPanel.tsx");

    expect(workspaceBar).not.toContain("openForMission");
    expect(opsBoard).not.toContain("openForMission");
    expect(orchestrationPanel).toContain('title="Configurar squad"');
    expect(orchestrationPanel).toContain(
      "useMissionWizardStore.getState().openForMission()",
    );
  });

  it("leaves experimental Maestro acknowledgement to the native approval", () => {
    const wizard = source("components/MissionWizard.tsx");
    const review = source("components/MissionWizardReview.tsx");

    expect(wizard).not.toContain("experimentalOrchestratorAcknowledgement");
    expect(review).not.toContain("experimentalOrchestratorAcknowledged");
    expect(review).toContain("A aprovação nativa");
    expect(review).toContain("única confirmação");
  });

  it("keeps every mounted contextual product surface reachable", () => {
    const app = source("App.tsx");
    const commandPalette = source("components/CommandPalette.tsx");

    for (const tab of ["skills", "marketplace", "browser", "memory"]) {
      expect(app).toContain(`'${tab}'`);
      expect(commandPalette).toContain(`openTab('${tab}')`);
    }
  });
});
