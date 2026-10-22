import { describe, expect, it, vi } from 'vitest';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { agentPrompt } from './mission-fast-lane';
import { evaluateHandoffEvidence } from './jev-handoff-review';
import { mechanicalChecksStillValid } from './mission-code-completion-production';
import {
  armAutoCloseOnHandoff,
  armedAutoClosePaneId,
  closeAfterNonSuccessHandoffAck,
  disarmAutoCloseOnHandoff,
  scheduleAutoCloseAfterHandoff,
} from './pane-close-scopes';
import { visualEvidenceVerified } from './visual-handoff-gate';

/**
 * Orçamento de cerimônia de uma missão de landing page (21/10/2026).
 *
 * O operador pediu para "simular missões do tipo de fazer uma landing page,
 * testar e ver o tempo… ou simular só via testes mesmo". Não há como rodar uma
 * LLM real aqui, então isto NÃO é cronômetro de ponta a ponta: é um modelo que
 * dirige as FUNÇÕES REAIS de decisão do motor numa linha do tempo com relógio
 * falso e conta os eventos caros — execução da suíte mecânica, rodada de
 * worker, turno de coordenação.
 *
 * Os custos por evento são medidos nesta máquina (21/10): typecheck do projeto
 * 4,4 s, `npm audit` 0,75 s, fatia orch+shared da suíte 208 s. Os tetos de
 * `mechanical-sensors.ts` (120 s typecheck, 45 s audit) são TIMEOUT, não custo
 * — não os use como se fossem.
 *
 * O valor deste arquivo é ser catraca: se alguém reintroduzir o descarte da
 * verificação válida, o fecho no submit ou a dupla cobrança da entrega visual,
 * os números aqui pioram e o teste reprova.
 */

/**
 * Custos por evento. Medidos neste repositório em 21/10:
 *
 * - typecheck do projeto inteiro: 4,4 s (3 execuções)
 * - `npm audit`: 0,75 s (2 execuções)
 * - fatia orch+shared da suíte: 208 s para 766 arquivos ⇒ ~0,27 s/arquivo
 * - o portão de regressão REAL, chamado contra o diff deste PR (22 arquivos),
 *   mapeou 286 arquivos de teste impactados, e rodou duas vezes porque a
 *   chave de cache do handoff (`fast`) e a da conclusão (`with-e2e`) são
 *   distintas
 *
 * Daí `IMPACTED_SUITE_MS`: 286 × 0,27 s ≈ 77 s. É DERIVADO da vazão medida,
 * não cronometrado — executar os 286 sob o portão exigia conceder a raiz de
 * dependências do sandbox, que esta máquina não tem. O número depende do
 * projeto: numa landing page pequena é muito menor. O que NÃO depende do
 * projeto é a contagem de eventos, e é ela que os testes acima fixam.
 */
const TYPECHECK_MS = 4_400;
const AUDIT_MS = 750;
const IMPACTED_SUITE_FILES = 286;
const SUITE_MS_PER_FILE = 208_000 / 766;
const IMPACTED_SUITE_MS = Math.round(IMPACTED_SUITE_FILES * SUITE_MS_PER_FILE);
const MECHANICAL_RUN_MS = TYPECHECK_MS + AUDIT_MS + IMPACTED_SUITE_MS;
/** Turno de LLM: a faixa observada em campo é 30–90 s; usamos o meio. */
const LLM_TURN_MS = 60_000;

/** O juiz frontier lê o candidato por mais tempo que o TTL comum de 5 min. */
const JUDGE_READ_MS = 8 * 60_000;

const mission = (description: string): Mission =>
  ({
    id: 'm-landing',
    title: 'Landing page Navalha Go',
    description,
    status: 'running',
    updatedAt: 1,
    intentVersion: 1,
    intentContract: { lane: 'standard', goal: description },
    orchestratorSessionId: 'maestro',
  }) as Mission;

const orchestrator = (): SquadAgent =>
  ({ agentName: 'Maestro', category: 'orchestrator', cli: 'claude' }) as SquadAgent;

const OBJECTIVE =
  'Faça uma landing page do Navalha Go, visual feminino, com hero, serviços, depoimentos e CTA de agendamento.';

/**
 * Quantas vezes a suíte mecânica roda enquanto o juiz lê o MESMO candidato.
 * `reviewInFlight: false` reproduz a regra antiga (só TTL); `true` é a de hoje.
 */
function mechanicalRuns(reviewInFlight: boolean, judgeReadMs = JUDGE_READ_MS): number {
  let runs = 1; // a primeira execução é trabalho legítimo
  let lastRunAt = 0;
  // O motor reavalia a cada acordada (RETRY_MS = 30 s) enquanto espera o juiz.
  for (let now = 30_000; now <= judgeReadMs; now += 30_000) {
    if (!mechanicalChecksStillValid({ ageMs: now - lastRunAt, reviewInFlight })) {
      runs += 1;
      lastRunAt = now;
    }
  }
  return runs;
}

/** A entrega visual devolve por "sem evidência de verificação"? */
function visualDeliveryBounces(countVisualCapture: boolean): boolean {
  const capture = { required: true, verified: true, artifactId: 'shot-1', sha256: 'f'.repeat(64) } as const;
  // F-1635: `.html` NÃO é só-aparência (carrega JavaScript embutido), então
  // uma landing page de arquivo único continua devendo prova de verificação —
  // e continua custando UMA devolução. A dispensa vale para a entrega que é
  // só folha de estilo e imagem. Isto é o preço escolhido de falhar fechado:
  // ver a thread do 10º achado no PR 159.
  const facts = {
    declaredFiles: ['estilo.css', 'hero.svg'],
    evidenceIdsCount: 0,
    hasObservedCommit: false,
    ...(countVisualCapture ? { hasVisualEvidence: visualEvidenceVerified(capture) } : {}),
  };
  // O modelo não acha saída de teste numa entrega de aparência — não existe.
  const answers = {
    is_specific: { type: 'noul' as const, noul: 0.9 },
    has_verification: { type: 'noul' as const, noul: 0.1 },
    changed_code: { type: 'noul' as const, noul: 0.9 },
  };
  return evaluateHandoffEvidence(answers, facts)
    .some((signal) => signal.includes('evidência de verificação'));
}

/**
 * A devolução chega a um pane MORNO (que já sabe o que tentou) ou a um pane
 * novo com o brief original? Dirige o agendador real.
 */
function reworkLandsWarm(awaitAckOnSuccess: boolean): boolean {
  const paneOf = (sessionId: string) => (sessionId === 'w-1' ? 'pane-1' : null);
  const closed: string[] = [];
  const close = async (paneId: string): Promise<boolean> => {
    closed.push(paneId);
    return true;
  };
  armAutoCloseOnHandoff('w-1', 'pane-1');
  scheduleAutoCloseAfterHandoff('w-1', 'success', paneOf, close, {
    handoffId: 'h-1',
    ...(awaitAckOnSuccess ? { awaitAckOnSuccess: true } : {}),
  });
  // O Maestro acorda, lê a entrega e devolve com a nota.
  vi.advanceTimersByTime(1_000);
  closeAfterNonSuccessHandoffAck('w-1', 'h-1', 'rework');
  vi.advanceTimersByTime(1_000);
  const warm = closed.length === 0 && armedAutoClosePaneId('w-1', 'pane-1') !== null;
  disarmAutoCloseOnHandoff('w-1', 'pane-1');
  return warm;
}

describe('orçamento de cerimônia: landing page como missão', () => {
  it('a verificação válida não é mais jogada fora enquanto o juiz lê', () => {
    const antes = mechanicalRuns(false);
    const depois = mechanicalRuns(true);
    expect(antes).toBeGreaterThan(1);
    expect(depois).toBe(1);
    // Com o TTL de 5 min e um juiz de 8 min, a suíte rodava ao menos 2 vezes.
    expect(antes).toBeGreaterThanOrEqual(2);
  });

  // A propriedade que importa não é um número, é a INCLINAÇÃO: no motor antigo
  // o desperdício crescia com o tempo de revisão (uma suíte inteira a cada
  // TTL), então rejeição + reparo pioravam exatamente o caso já ruim. Agora é
  // constante enquanto o candidato não muda.
  it('o desperdício antigo crescia com a duração da revisão; agora é constante', () => {
    for (const judgeMs of [8, 15, 25, 40].map((min) => min * 60_000)) {
      expect(mechanicalRuns(true, judgeMs)).toBe(1);
    }
    const antes = [8, 15, 25, 40].map((min) => mechanicalRuns(false, min * 60_000));
    // Estritamente crescente: cada janela de TTL custava a suíte de novo.
    for (let i = 1; i < antes.length; i += 1) {
      expect(antes[i]).toBeGreaterThan(antes[i - 1]!);
    }
    expect(antes.at(-1)).toBeGreaterThanOrEqual(8);
  });

  it('a captura do navegador encerra a dupla cobrança da entrega visual', () => {
    expect(visualDeliveryBounces(false)).toBe(true);
    expect(visualDeliveryBounces(true)).toBe(false);
  });

  it('o turno de abertura não é mais gasto num handoff_list vazio', () => {
    const semPlano = agentPrompt(orchestrator(), mission(OBJECTIVE), [], false, '', null, []);
    expect(semPlano).toContain('Para cada tarefa ainda não despachada');
    expect(semPlano).not.toContain('Não duplique a first-wave');
  });

  it('a devolução chega a um pane morno, não a um pane novo com o brief original', () => {
    vi.useFakeTimers();
    try {
      expect(reworkLandsWarm(false)).toBe(false);
      expect(reworkLandsWarm(true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('o orçamento total da entrega melhora, e o relatório sai nos números', () => {
    const suiteAntes = mechanicalRuns(false);
    const suiteDepois = mechanicalRuns(true);

    // Rodadas de worker: antes, a devolução por evidência visual custava uma
    // rodada inteira (pane já fechado no submit => brief original, do zero).
    const rodadasAntes = 1 + (visualDeliveryBounces(false) ? 1 : 0);
    const rodadasDepois = 1 + (visualDeliveryBounces(true) ? 1 : 0);

    // Turnos de coordenação: o de abertura desperdiçado some.
    const turnosAntes = 1;
    const turnosDepois = 0;

    const custo = (suite: number, rodadas: number, turnos: number): number =>
      suite * MECHANICAL_RUN_MS + rodadas * LLM_TURN_MS + turnos * LLM_TURN_MS;

    const antes = custo(suiteAntes, rodadasAntes, turnosAntes);
    const depois = custo(suiteDepois, rodadasDepois, turnosDepois);

    console.log(
      `[orçamento] suíte mecânica ${suiteAntes}x -> ${suiteDepois}x; ` +
        `rodadas de worker ${rodadasAntes} -> ${rodadasDepois}; ` +
        `turnos desperdiçados ${turnosAntes} -> ${turnosDepois}; ` +
        `custo modelado ${(antes / 60_000).toFixed(1)} min -> ${(depois / 60_000).toFixed(1)} min ` +
        `(-${(((antes - depois) / antes) * 100).toFixed(0)}%) por unidade de entrega`,
    );

    expect(depois).toBeLessThan(antes);
    // Por unidade de entrega, o corte precisa ser material, não cosmético.
    expect(depois / antes).toBeLessThan(0.75);
  });
});
