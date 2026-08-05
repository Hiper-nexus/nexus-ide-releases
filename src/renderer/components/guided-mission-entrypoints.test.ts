// Copyright (c) 2026 Lovecast Inc. — MIT License
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = path.resolve(import.meta.dirname, "..");

function source(relativePath: string): string {
  return readFileSync(path.join(RENDERER, relativePath), "utf8");
}

describe("guided mission entrypoints", () => {
  it("opens the mode picker from generic new-mission actions", () => {
    const app = source("App.tsx");
    const home = source("components/HomeDeck.tsx");
    const workspaceBar = source("components/WorkspaceBar.tsx");
    const missionRail = source("components/MissionRail.tsx");
    const commandPalette = source("components/CommandPalette.tsx");
    const canvas = source("components/CanvasView.tsx");
    const opsBoard = source("components/OpsBoard.tsx");
    const cmdN = app.slice(
      app.indexOf("// ⌘N — nova missão:"),
      app.indexOf("// ⌘1-9"),
    );

    expect(cmdN).toContain("e.key.toLowerCase() === 'n' && !e.shiftKey");
    expect(cmdN).toContain("openForMission()");
    expect(cmdN).not.toContain("openForAgentic()");
    expect(home).toContain("<MissionComposer");
    expect(home).toContain("onSubmit={submitObjective}");
    // Contrato atual do HomeDeck, deliberado em 8e0e78fc e documentado em
    // HomeDeck.submitObjective: "Com texto: piloto automático (objetivo-first).
    // Sem texto: seletor de modo (Livre / Squad / Agêntico) — o operador
    // escolhe o formato, não cai direto no REVISAR de um time default."
    // Antes desse commit o caminho sem texto chamava openAgentic() e o
    // HomeDeck não podia sequer referenciar openForMission; hoje o seletor de
    // modo É openForMission (mesma autoridade exigida do ⌘N na linha acima),
    // então a guarda passa a exigir o binding em vez de proibi-lo.
    expect(home).toContain("openAgentic(intent.trim())");
    expect(home).toContain("openMission();");
    expect(home).not.toContain('className="home-deck__btn"');
    expect(home).toContain(
      "const openMission = useMissionWizardStore((s) => s.openForMission);",
    );
    expect(workspaceBar).toMatch(
      /workspace-bar__btn--primary[\s\S]*?onClick=\{\(\) => openMission\(\)\}/,
    );
    expect(
      missionRail.match(/onClick=\{\(\) => openMission\(\)\}/g),
    ).toHaveLength(1);
    expect(
      commandPalette.match(
        /useMissionWizardStore\.getState\(\)\.openForMission\(\)/g,
      ),
    ).toHaveLength(2);
    expect(canvas).not.toContain("Nova missão");
    expect(canvas).not.toContain("useMissionWizardStore");
    expect(opsBoard).toContain(
      "const openWizard = useMissionWizardStore((s) => s.openForMission);",
    );
  });

  it("keeps explicit objective submissions on the agentic path", () => {
    const workspaceBar = source("components/WorkspaceBar.tsx");
    const opsBoard = source("components/OpsBoard.tsx");
    const orchestrationPanel = source("components/OrchestrationPanel.tsx");

    expect(workspaceBar).toContain("openForMission");
    expect(opsBoard).toContain("openForMission");
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
