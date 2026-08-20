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
    expect(prompt).toContain("nexus_pane_read");
    expect(prompt).toMatch(/olhar o que outro pane/);
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

// C-194.1 (modelo invertido do Overclock): com fechamento mecânico no Main
// (turn-end-handoff), o contrato do worker de missão vira CONDICIONAL por
// tamanho — e precisa concordar com o enum da tool (a contradição
// "sempre chame" × "não chame se couber" era o bug).
describe('contrato condicional (systemDelivers, C-194.1)', () => {
  const adapter = { quirks: { mcpAutoload: false, nexusMcp: 'opencode' } };

  it('ensina a regra ≤280 → nenhuma tool, entrega verbatim pelo sistema', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter, {
      systemDelivers: true,
    });
    expect(prompt).toContain('280 caracteres');
    expect(prompt).toContain('entregue ao orquestrador AUTOMATICAMENTE');
    expect(prompt).toContain('NÃO chame ferramenta nenhuma');
  });

  it('ensina o vocabulário CANÔNICO da tool — nunca done/error', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter, {
      systemDelivers: true,
    });
    expect(prompt).toContain('"success"|"blocked"|"failed"');
    expect(prompt).not.toContain('"done"');
    expect(prompt).not.toContain('"error"');
  });

  it('NÃO contém a instrução contraditória do contrato clássico', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter, {
      systemDelivers: true,
    });
    expect(prompt).not.toContain('finalize chamando a tool nexus_handoff_submit');
  });

  it('mantém peerRead e aceita nx-mail como fallback no modo condicional', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter, {
      systemDelivers: true,
    });
    expect(prompt).toContain('nexus_pane_read');
    expect(prompt).toContain('nx-mail send');
  });

  it('sem a flag, o contrato clássico permanece intacto (regressão)', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter);
    expect(prompt).toContain('finalize chamando a tool nexus_handoff_submit');
    expect(prompt).not.toContain('NÃO chame ferramenta nenhuma');
  });
});

describe('charter tier — pergunta aos panes não paga carta nenhuma', () => {
  it('meta-de-pane zera engineering/design/lean', () => {
    expect(
      charterTierForWorker({
        prompt: 'quanto e 1+1 pergunte a todos panes — responda: quanto é 1+1?',
      }),
    ).toEqual({ engineering: false, design: false, lean: false });
  });

  it('task de código continua com as cartas', () => {
    const tier = charterTierForWorker({
      prompt: 'implementar cache LRU no serviço de sessões',
    });
    expect(tier.engineering).toBe(true);
    expect(tier.lean).toBe(true);
  });
});
