import { isUiMissionText } from '../../shared/mission-work-kind';
import { hasUiWorkTerm } from '../../shared/ui-work-signal';
import { selectDesignDirection } from '../design/design-kit-selection';
import { listLocalDesignCatalog } from '../design/local-design-catalog';
import { getOrchSettings } from '../persistence/settings-store';
import { composeDesignCharter } from './design-profile';
import { resolveWorkspaceDesignContract } from './design-system-reader';
import { homeRelativePath, OUTSIDE_HOME_LABEL } from './home-relative-path';

/** Cabeçalho da regra. O hook do operador o procura para não repeti-la a um helper que já nasceu com ela. */
export const WORKSPACE_DESIGN_RULE_HEADING = 'Regra de design do projeto';

export interface DesignRuleOptions {
  /** `orch.designLocalCatalogDir`; vazio = ~/.design-references. */
  readonly catalogDir?: string | null;
  /** `orch.designDefaultKit`; vazio = nenhuma referência fixada. */
  readonly pinnedKitId?: string | null;
}

function settingsOptions(): DesignRuleOptions {
  const orch = getOrchSettings();
  return { catalogDir: orch.designLocalCatalogDir, pinnedKitId: orch.designDefaultKit };
}

/** Home-relativo dentro do home (sem o nome da conta); fora dele, o caminho real. */
function displayDir(dir: string): string {
  const relative = homeRelativePath(dir);
  return relative === OUTSIDE_HOME_LABEL ? dir : relative;
}

interface CatalogReference {
  readonly line: string;
  readonly kitId: string | null;
}

/**
 * Sem contrato aplicado, o catálogo local (~/.design-references) é a fonte de
 * direção visual. A escolha é a mesma regra determinística do bootstrap do
 * contrato (`selectDesignDirection`): referência fixada, casamento estrito por
 * domínio ou, sem evidência, a lista para o agente escolher.
 */
function catalogReference(taskText: string, options: DesignRuleOptions): CatalogReference {
  const catalog = listLocalDesignCatalog({ dir: options.catalogDir || undefined });
  if (catalog.kits.length === 0) {
    return {
      line: 'Se precisar de direção visual, consulte as referências com nexus_design_system_local_list e informe a escolhida.',
      kitId: null,
    };
  }
  const dir = displayDir(catalog.dir);
  const ids = catalog.kits.map((kit) => kit.kitId);
  const choice = selectDesignDirection({ goal: taskText, pinnedKitId: options.pinnedKitId, kits: catalog.kits });
  if (choice.mode === 'neutral') {
    return {
      line: `Para a direção visual, escolha no catálogo local (${dir}: ${ids.join(', ')}) a referência mais próxima do produto.`,
      kitId: null,
    };
  }
  const why = choice.mode === 'setting'
    ? 'fixada nas configurações do Nexus'
    : `sugerida para este pedido: ${choice.sharedAxes.join(', ')}`;
  const others = ids.filter((id) => id !== choice.kit.kitId);
  return {
    line: `Para a direção visual, leia ${dir}/${choice.kit.locator} (referência ${why})` +
      (others.length > 0 ? `; outras no catálogo: ${others.join(', ')}.` : '.'),
    kitId: choice.kit.kitId,
  };
}

function authorityLines(
  workspaceRoot: string,
  taskText: string,
  options: DesignRuleOptions,
  offerContractImport: boolean,
): string[] | null {
  const contract = resolveWorkspaceDesignContract(workspaceRoot);
  if (contract) {
    return [`Leia ${contract.path} antes de editar a interface. Este é o contrato visual do projeto; referências externas são complementares.`];
  }
  if (!hasUiWorkTerm(taskText)) return null;
  const reference = catalogReference(taskText, options);
  const lines = [
    'O projeto não tem contrato visual aplicado (DESIGN.md ou .context/docs/design-system.md). Consulte AGENTS.md e siga primeiro os tokens e componentes que o código já usa.',
    reference.line,
  ];
  // Só a sessão do operador propõe contrato; o worker apenas o segue.
  if (offerContractImport && reference.kitId) {
    lines.push(`Para fixar essa referência no projeto, proponha o contrato com nexus_design_system_local_import({ kitId: "${reference.kitId}" }).`);
  }
  return lines;
}

function ruleText(lines: readonly string[]): string {
  return `${WORKSPACE_DESIGN_RULE_HEADING} (sempre que o trabalho envolver UI):\n${lines.join('\n')}\nReutilize tokens e componentes existentes. Na entrega, identifique a referência usada e como verificou a interface renderizada; se não conseguiu ler ou verificar, declare a limitação. Não apresente uma proposta de design ainda não aplicada como regra vigente.`;
}

/** Project style authority is independent of the optional design coaching toggle. */
export function withWorkspaceDesignRule(
  prompt: string,
  workspaceRoot: string,
  taskText = prompt,
  options: DesignRuleOptions = settingsOptions(),
): string {
  const lines = authorityLines(workspaceRoot, taskText, options, false);
  return lines ? `${prompt}\n\n${ruleText(lines)}` : prompt;
}

export interface OperatorDesignOptions extends DesignRuleOptions {
  /** Carta de Design composta; null = `orch.designPro` desligado. */
  readonly charter?: string | null;
}

function settingsOperatorOptions(): OperatorDesignOptions {
  const orch = getOrchSettings();
  return { ...settingsOptions(), charter: orch.designPro ? composeDesignCharter(orch) : null };
}

/**
 * O que um worker de UI recebe no prompt de spawn (regra do projeto + Carta de
 * Design), para o pane do operador, que não tem prompt de spawn: o hook
 * UserPromptSubmit injeta isto quando a mensagem pede trabalho de interface.
 * Aqui o gatilho exige verbo de construção (`isUiMissionText`): o hook roda a
 * cada mensagem, e "a tela congela quando fecho o pane" é relato de bug, não
 * pedido de design.
 */
export function operatorDesignContext(
  prompt: string,
  workspaceRoot: string,
  options: OperatorDesignOptions = settingsOperatorOptions(),
): string | null {
  if (!isUiMissionText(prompt)) return null;
  const lines = authorityLines(workspaceRoot, prompt, options, true);
  if (!lines) return null;
  const rule = ruleText(lines);
  return options.charter ? `${rule}\n\n${options.charter}` : rule;
}
