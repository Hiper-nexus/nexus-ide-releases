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
    "Se a tool MCP não estiver disponível, use no shell: " +
    'nx-mail send --status success --summary "<resumo objetivo>". ' +
    "Esse comando entra no mesmo dispatcher e na mesma cadeia de receipts.";
  const contract = viaMcp
    ? 'Ao concluir sua tarefa, finalize chamando a tool nexus_handoff_submit ' +
      'com {status: "success"|"partial"|"failed", summary, artifacts}. ' +
      shimFallback
    : "Ao concluir sua tarefa, tente primeiro o canal canônico em disco. " +
      shimFallback +
      " Se nx-mail também estiver indisponível, imprima EXATAMENTE este bloco " +
      "como texto no terminal (é o fallback físico final):\n" +
      `${LEGACY_MARKER}\n` +
      '{"status":"success","summary":"<resumo objetivo do que fez>","artifacts":[]}';
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
  return `${prompt}${charter}${design}${lean}\n\n${contract}`;
}


