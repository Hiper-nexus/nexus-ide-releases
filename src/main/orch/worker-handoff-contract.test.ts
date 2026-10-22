import { describe, expect, it, vi } from "vitest";

vi.mock("../persistence/settings-store", () => ({
  getOrchSettings: () => ({
    seniorMode: false,
    designPro: false,
    leanCode: false,
  }),
}));

import { LEGACY_MARKER } from "./legacy-handoff";
import { NEXUS_BROWSER_BRIEF_RULE } from "./nexus-browser-policy";
import { charterTierForWorker, withHandoffContract } from "./worker-handoff-contract";

describe("worker handoff transport contract", () => {
  it("teaches a CLI without Nexus MCP the filesystem shim before the physical PTY fallback", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "none" },
    });

    expect(prompt).toContain(LEGACY_MARKER);
    expect(prompt).toContain("nx-mail send");
    expect(prompt).toContain('"status":"success"');
    expect(prompt).not.toContain("chamando a tool nexus_handoff_submit");
  });

  it("proíbe o worker de apagar o node_modules ligado ao checkout de origem (Node 24 atravessa o junction)", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "none" },
    });
    expect(prompt).toContain("nunca o apague nem reinstale");
    expect(prompt).toContain("Node 24");
  });

  it.each(["opencode", "agy"])("keeps physically usable MCP adapters on nexus_handoff_submit (%s)", (nexusMcp) => {
    // F-697: o AGY entrega pelo MCP da ponte registrada no perfil nativo.
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp },
    });

    expect(prompt).toContain("chamando a tool nexus_handoff_submit");
    expect(prompt).toContain("nx-mail send");
    expect(prompt).toContain("nexus_pane_read");
    expect(prompt).toMatch(/olhar o que outro pane/);
    expect(prompt).not.toContain(LEGACY_MARKER);
  });

  it("worker não pergunta ao humano e conserva a autoridade de execução do pane", () => {
    for (const nexusMcp of ["codex", "none"]) {
      const prompt = withHandoffContract("Corrija o achado RU-263.", {
        quirks: { mcpAutoload: false, nexusMcp },
      });
      expect(prompt).toContain("nunca pare para perguntar");
      expect(prompt).toContain("request_user_input");
      expect(prompt).toContain("o Nexus vence");
      expect(prompt).toContain('"blocked"');
      expect(prompt).toContain("spawn_agent");
      expect(prompt).toContain("Você pode usar ferramentas e subagentes nativos");
      expect(prompt).not.toContain("Não abra subagentes internos");
    }
  });

  it("ensina a doutrina da memória compartilhada onde as tools MCP existem (F-769)", () => {
    const withMcp = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "agy" },
    });
    expect(withMcp).toContain("nexus_memory_recall");
    expect(withMcp).toContain("nexus_memory_retain");
    expect(withMcp).toMatch(/antes de mexer numa área desconhecida/);
    expect(withMcp).toMatch(/Antes do handoff, grave as pegadinhas/);

    // CLI sem MCP do Nexus (shim de disco): a menção seria ruído.
    const shimOnly = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "none" },
    });
    expect(shimOnly).not.toContain("nexus_memory_recall");
    expect(shimOnly).not.toContain("nexus_memory_retain");
  });

  it.each(["codex", "kimi", "grok", "agy"])(
    "F-781: o brief do %s recomenda o navegador do Nexus para página web quando o pane o alcança, sem proibir WebFetch nem curl",
    (nexusMcp) => {
      const prompt = withHandoffContract("Leia a documentação da API e corrija o cliente.", {
        quirks: { mcpAutoload: false, nexusMcp },
      }, { nexusBrowser: true });
      expect(prompt).toContain(NEXUS_BROWSER_BRIEF_RULE);
      expect(prompt).toContain("nexus_browser_open");
      // F-1157: a regra recomenda o navegador e libera WebFetch, fetch nativo e curl.
      expect(prompt).toContain(
        "WebFetch, o fetch nativo da sua CLI e curl também estão liberados",
      );
      expect(prompt).not.toContain("Não use WebFetch");
      // A regra vem antes do contrato de entrega (a última instrução do brief).
      expect(prompt.indexOf("nexus_browser_open")).toBeLessThan(
        prompt.indexOf("Ao concluir sua tarefa"),
      );
    },
  );

  it("F-781: sem o navegador ao alcance (ou sem MCP), o brief não manda usar o que não existe", () => {
    const withoutBrowser = withHandoffContract("Leia a documentação da API.", {
      quirks: { mcpAutoload: false, nexusMcp: "codex" },
    });
    expect(withoutBrowser).not.toContain("nexus_browser_open");

    const shimOnly = withHandoffContract("Leia a documentação da API.", {
      quirks: { mcpAutoload: false, nexusMcp: "none" },
    }, { nexusBrowser: true });
    expect(shimOnly).not.toContain("nexus_browser_open");
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
    expect(prompt).toContain('"success"|"partial"|"blocked"|"failed"');
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

  it('não ensina uma resposta curta a fechar tarefa com validação pendente', () => {
    const prompt = withHandoffContract('Crie um jogo Phaser.', adapter, {
      systemDelivers: true,
    });
    expect(prompt).toContain('concluída e verificada');
    expect(prompt).toContain('validação pendente');
    expect(prompt).toContain('status "partial"');
  });

  it('sem a flag, o contrato clássico permanece intacto (regressão)', () => {
    const prompt = withHandoffContract('Corrija o fluxo.', adapter);
    expect(prompt).toContain('finalize chamando a tool nexus_handoff_submit');
    expect(prompt).not.toContain('NÃO chame ferramenta nenhuma');
  });
});

describe('evidência visual no handoff', () => {
  const adapter = { quirks: { mcpAutoload: false, nexusMcp: 'codex' } };

  it.each(['Implemente o frontend.', 'Crie um jogo Phaser.'])('pede validação real da entrega: %s', (task) => {
    const prompt = withHandoffContract(task, adapter);
    expect(prompt).toContain('Validação visual de interface ou jogo');
    expect(prompt).toContain('nexus_browser_do');
    expect(prompt).toContain('nexus_browser_judge_visual');
    expect(prompt).toContain('URL/preview, viewport, ações');
    expect(prompt).toContain('não verificada');
    expect(prompt).toContain('partial');
    expect(prompt).toContain('Nunca invente screenshots');
  });

  // F-1636: "ambiente necessário falhou" virava `partial` sem o worker tentar
  // servir a entrega — e `partial` custa uma devolução inteira. O pane tem
  // terminal: subir o preview é trabalho dele, não ferramenta indisponível.
  it('manda subir o preview antes de declarar o ambiente indisponível', () => {
    const prompt = withHandoffContract('Implemente o frontend.', adapter);
    expect(prompt).toContain('nexus_preview_start({dir})');
    expect(prompt.indexOf('nexus_preview_start({dir})')).toBeLessThan(
      prompt.indexOf('registre a validação como não verificada'),
    );
  });

  // Revisão 22/10 (P0-6): o brief mandava subir `npm run dev` ou abrir o
  // arquivo local, e o navegador do Nexus recusa os dois (private-network,
  // unsafe-scheme). O único caminho que funciona é o preview do Nexus.
  it('manda o caminho que o navegador aceita, não npm run dev nem file://', () => {
    const prompt = withHandoffContract('Implemente o frontend.', adapter);
    expect(prompt).toMatch(/nexus_preview_start\(\{dir\}\)[\s\S]*nexus_browser_open[\s\S]*nexus_browser_responsive/);
    expect(prompt).not.toMatch(/servidor de dev do projeto ou o arquivo local/);
    expect(prompt).toMatch(/não suba `npm run dev` para verificar/);
  });

  // F-1636: achado em campo construindo uma landing page nesta sessão. A
  // captura tirada logo depois de rolar pegou a página EM BRANCO, porque a
  // animação de entrada levava 900 ms. Um worker seguindo o contrato
  // produziria essa captura enganosa e reportaria defeito que não existe — ou
  // seria devolvido por "evidência ruim".
  it('manda esperar o movimento assentar antes de capturar', () => {
    const prompt = withHandoffContract('Implemente o frontend.', adapter);
    expect(prompt).toMatch(/anima(ção|ções)/i);
    expect(prompt.indexOf('assentar')).toBeGreaterThan(-1);
  });

  it('não acrescenta orientação visual a trabalho de backend', () => {
    const prompt = withHandoffContract('Implemente cache LRU no serviço de sessões.', adapter);
    expect(prompt).not.toContain('Validação visual de interface ou jogo');
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

describe('charter tier — helper somente leitura entrega texto, não diff', () => {
  it('não recebe carta de engenharia, de design nem a ponytail', () => {
    expect(
      charterTierForWorker({
        prompt: 'Analise o renderer e redesenhe a tela de login — só leitura, relatório.',
        readOnly: true,
      }),
    ).toEqual({ engineering: false, design: false, lean: false });
  });

  it('o mesmo pedido num escritor continua com as cartas', () => {
    expect(
      charterTierForWorker({ prompt: 'Implemente e redesenhe a tela de login.' }),
    ).toEqual({ engineering: true, design: true, lean: true });
  });
});

describe('the UI kit survives Design Pro being off', () => {
  // Review 22/10: the kit line lived only inside the design charter, so
  // switching Design Pro off switched the kit off with it.
  it('a UI worker without the charter still gets the kit line', () => {
    const prompt = withHandoffContract('Crie a tela de login do app em React.', {
      quirks: { mcpAutoload: true, nexusMcp: 'autoload' },
    });

    expect(prompt).toContain('nexus_ui_kit_add({task})');
    expect(prompt).not.toContain('# Design Charter');
  });

  it('a backend worker does not get it', () => {
    const prompt = withHandoffContract('Implemente cache LRU no serviço de sessões.', {
      quirks: { mcpAutoload: true, nexusMcp: 'autoload' },
    });

    expect(prompt).not.toContain('nexus_ui_kit_add');
  });
});
