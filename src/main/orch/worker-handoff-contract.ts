import {
  collectUiWorkEvidence,
  isUiWorkText,
} from '../../shared/ui-work-signal';
import { LEGACY_MARKER } from './legacy-handoff';
import { PONYTAIL_RULES } from './ponytail';
import { ENGINEERING_CHARTER } from './engineering-charter';
import { composeDesignCharter } from './design-profile';
import { getOrchSettings } from '../persistence/settings-store';
import { canUseNexusMcp } from './cli-mcp-inject';

/**
 * UI-shaped work, detectado no brief da tarefa + título do pane/nome do agente.
 *
 * Usa a MESMA tabela de termos de `src/shared/ui-work-signal.ts` — a regex
 * local anterior era a QUINTA gramática de "isto é UI?" do produto e carregava
 * o defeito de acento das outras (`p[aá]gina` casava dentro de `paginação`, e
 * todo worker de CRUD de backend recebia a carta de design).
 *
 * Mas o LIMIAR aqui é deliberadamente mais generoso que o da missão guiada, e
 * é por isso que este predicado existe em vez de chamar `isUiWorkText` direto.
 * Os custos são assimétricos:
 *
 *   - Na missão guiada, um falso positivo concede skills de design, escreve um
 *     DESIGN.md e passa a exigir screenshot do revisor. Caro. Daí o quórum de
 *     dois termos ambíguos.
 *   - Aqui, um falso positivo custa ~8 KB de prompt; um falso NEGATIVO manda
 *     alguém construir "a página de onboarding" sem nenhuma orientação de
 *     design — exatamente o resultado genérico que o produto existe para
 *     evitar.
 *
 * Então: qualquer termo de UI basta (craft, locativo ou traço), sem quórum. O
 * que NÃO acontece mais é casar dentro de outra palavra — a canonicalização e
 * as fronteiras vêm da tabela compartilhada, não de um regex paralelo.
 */
function isUiShapedWork(corpus: string): boolean {
  if (isUiWorkText(corpus)) return true;
  const evidence = collectUiWorkEvidence(corpus);
  return evidence.matches.length > 0;
}

export interface HandoffContractHints {
  /** Squad role category — scouts/architects read and plan, they don't ship diffs. */
  category?: string;
  /** Extra corpus (title, agent name) for the UI-task detection. */
  hints?: Array<string | undefined>;
  /**
   * C-194.1 (modelo invertido do Overclock): o Main fecha o turno
   * mecanicamente (turn-end-handoff) quando o worker termina sem chamar a
   * tool. Com isso, resposta curta (≤280 chars) NÃO chama ferramenta nenhuma —
   * o sistema entrega verbatim. A tool fica para resposta longa ou
   * blocked/failed, com o vocabulário canônico do enum. Só deve ser `true`
   * onde o fechamento mecânico existe (worker de missão com hook de status);
   * sem isso, ensinar "apenas encerre" perderia a resposta.
   */
  systemDelivers?: boolean;
}

/** Charters only help roles that produce code/UI; for the rest they are noise. */
export function charterTierForWorker(
  input: { prompt: string } & HandoffContractHints,
): { engineering: boolean; design: boolean; lean: boolean } {
  const category = input.category?.toLowerCase();
  // Recon/planning roles deliver analysis, not diffs — build discipline and
  // diff-size rules only dilute their brief.
  if (category === 'scout' || category === 'architect') {
    return { engineering: false, design: false, lean: false };
  }
  const corpus = [input.prompt, ...(input.hints ?? [])]
    .filter(Boolean)
    .join('\n');
  const uiTask = isUiShapedWork(corpus);
  if (category === 'reviewer') {
    // Reviewers judge against the engineering bar (and may refine code), but
    // the ponytail diff ladder targets authors, not critics.
    return { engineering: true, design: uiTask, lean: false };
  }
  // Executors and unclassified spawns: full build discipline; design charter
  // only when the task actually touches UI (its own applicability rule).
  return { engineering: true, design: uiTask, lean: true };
}

/**
 * Append the handoff contract a WORKER must fulfil, matched to what its CLI
 * can actually do. Every mission worker receives the private `nx-mail` command
 * on PATH; MCP-capable adapters may use the richer tool directly, while legacy
 * PTY parsing remains the final degraded path for older/non-governed spawns.
 */
export function withHandoffContract(
  prompt: string,
  adapter: { quirks: Record<string, unknown> },
  hints: HandoffContractHints = {},
): string {
  const viaMcp = canUseNexusMcp(adapter);
  const shimFallback =
    "Se a tool MCP não estiver disponível, rode no shell: " +
    'nexus_handoff_submit --status success --summary "<resumo objetivo>" ' +
    "(alias: nx-mail send …). Esse comando entra no mesmo dispatcher e na " +
    "mesma cadeia de receipts.";
  // Telemetria autorrelatada (overclick, 19/08): o agente é o único que vê o
  // próprio transcript — duração e tokens do turno. Honestidade em 3 regras:
  // números reais, estimativa marcada, ausência omitida (nunca zero).
  const telemetryContract =
    "Se o seu transcript mostrar duração e consumo do SEU turno, inclua " +
    "telemetry: {durationMs, tokensTotal, tokensByModel?, estimated?} no " +
    "nexus_handoff_submit — números REAIS do transcript; estimativa marca " +
    "estimated: true; sem dados, OMITA o campo (nunca invente zero).";
  const peerRead =
    'Quando o operador pedir para olhar o que outro pane está fazendo, chame ' +
    'nexus_pane_read com o número falado ("7" ou "pane 7"). Na mesma missão ' +
    'qualquer pane lê o outro, inclusive o orquestrador; panes de outra missão ' +
    'e o terminal do usuário ficam fora. Uma leitura basta — não entre em loop.';
  // C-194.1: com fechamento mecânico no Main, a regra muda de "sempre chame a
  // tool" para CONDICIONAL por tamanho — curta viaja verbatim por cópia de
  // código; longa ou blocked/failed é onde o resumo do modelo tem valor.
  const systemDeliversContract =
    viaMcp && hints.systemDelivers === true
      ? "Sua resposta é entregue ao orquestrador AUTOMATICAMENTE pelo sistema. " +
        "Responda normalmente neste pane, exatamente UMA vez (nunca em arquivo " +
        "ou artifacts, a menos que a tarefa peça). Se a resposta inteira couber " +
        "em 280 caracteres, apenas RESPONDA e ENCERRE o turno — o sistema " +
        "entrega verbatim; NÃO chame ferramenta nenhuma e NÃO repita a resposta. " +
        "SOMENTE quando a resposta NÃO couber em 280 caracteres (ou você " +
        "estiver bloqueado / tiver batido num erro), chame nexus_handoff_submit " +
        "como ÚLTIMA ação: " +
        '{summary: "1-2 frases — sua condensação da resposta (ou do bloqueio), ' +
        'na língua da tarefa", status: "success"|"blocked"|"failed", ' +
        'artifacts: [{fullText: "sua resposta completa, inalterada"}]}. ' +
        "Depois, uma linha curta de fechamento e PARE — não re-envie, não expanda. " +
        telemetryContract +
        " " +
        shimFallback
      : null;
  const contract = systemDeliversContract ?? (viaMcp
    ? 'Ao concluir sua tarefa, finalize chamando a tool nexus_handoff_submit ' +
      'com {status: "success"|"partial"|"failed", summary, artifacts}. ' +
      telemetryContract +
      ' ' +
      shimFallback
    : "Ao concluir sua tarefa, tente primeiro o canal canônico em disco. " +
      shimFallback +
      " Se nx-mail também estiver indisponível, imprima EXATAMENTE este bloco " +
      "como texto no terminal (é o fallback físico final):\n" +
      `${LEGACY_MARKER}\n` +
      '{"status":"success","summary":"<resumo objetivo do que fez>","artifacts":[]}');
  // Disciplina em camadas (toggles em Configurações › Squads): a Carta de
  // Engenharia dita o comportamento sênior (stack certa, gates verdes,
  // segurança, spec viva); o ponytail dita o tamanho do diff. O tier por
  // papel/tarefa mantém o prompt proporcional: missão curta não paga ~8 KB
  // de cartas que não se aplicam a ela.
  const orch = getOrchSettings();
  const tier = charterTierForWorker({ prompt, ...hints });
  const charter =
    orch.seniorMode && tier.engineering ? `\n\n${ENGINEERING_CHARTER}` : '';
  // A carta de design é composta com o perfil (direção + dials) do workspace;
  // perfil neutro degrada para a carta pura, sem custo extra de prompt.
  const design =
    orch.designPro && tier.design ? `\n\n${composeDesignCharter(orch)}` : '';
  const lean = orch.leanCode && tier.lean ? `\n\n${PONYTAIL_RULES}` : '';
  return `${prompt}${charter}${design}${lean}\n\n${peerRead}\n\n${contract}`;
}


