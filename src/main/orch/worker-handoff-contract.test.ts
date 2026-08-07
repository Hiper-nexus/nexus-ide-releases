import { describe, expect, it, vi } from "vitest";

vi.mock("../persistence/settings-store", () => ({
  getOrchSettings: () => ({
    seniorMode: false,
    designPro: false,
    leanCode: false,
  }),
}));

import { LEGACY_MARKER } from "./legacy-handoff";
import { charterTierForWorker, withHandoffContract } from "./worker-handoff-contract";

describe("worker handoff transport contract", () => {
  it("teaches AGY the filesystem shim before the physical PTY fallback", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "agy" },
    });

    expect(prompt).toContain(LEGACY_MARKER);
    expect(prompt).toContain("nx-mail send");
    expect(prompt).toContain('"status":"success"');
    expect(prompt).not.toContain("chamando a tool nexus_handoff_submit");
  });

  it("keeps physically usable MCP adapters on nexus_handoff_submit", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "opencode" },
    });

    expect(prompt).toContain("chamando a tool nexus_handoff_submit");
    expect(prompt).toContain("nx-mail send");
    expect(prompt).not.toContain(LEGACY_MARKER);
  });
});

// REGRESSAO: este arquivo tinha a QUINTA gramatica de "isto e UI?" do produto,
// com o mesmo defeito de acento das outras: `p[aá]gina` casava DENTRO de
// `paginacao`, entao todo worker de CRUD de backend recebia a carta de design.
// Agora delega a gramatica unica de src/shared/ui-work-signal.ts.
describe('deteccao de trabalho de UI no charter do worker', () => {
  const tier = (prompt: string) => charterTierForWorker({ prompt });

  it('nao entrega carta de design a worker de backend', () => {
    expect(tier('implementar o CRUD de usuarios com paginacao').design).toBe(false);
    expect(tier('implementar cache no servico de imagens').design).toBe(false);
    expect(tier('refatorar o core do servico de pagamento').design).toBe(false);
  });

  it('entrega carta de design a trabalho de interface de verdade', () => {
    expect(tier('redesenhar a tela de cobranca').design).toBe(true);
    expect(tier('ajustar o layout do dashboard').design).toBe(true);
    expect(tier('corrigir o css do botao primario').design).toBe(true);
  });

  it('scout e architect nunca recebem carta, mesmo em missao visual', () => {
    expect(
      charterTierForWorker({ prompt: 'redesenhar a tela', category: 'scout' }).design,
    ).toBe(false);
    expect(
      charterTierForWorker({ prompt: 'redesenhar a tela', category: 'architect' }).design,
    ).toBe(false);
  });
});
