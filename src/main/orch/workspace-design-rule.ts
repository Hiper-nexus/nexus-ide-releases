import { isUiWorkText } from '../../shared/ui-work-signal';
import { resolveWorkspaceDesignContract } from './design-system-reader';

/** Project style authority is independent of the optional design coaching toggle. */
export function withWorkspaceDesignRule(prompt: string, workspaceRoot: string, taskText = prompt): string {
  const contract = resolveWorkspaceDesignContract(workspaceRoot);
  if (!contract && !isUiWorkText(taskText)) return prompt;
  const authority = contract
    ? `Leia ${contract.path} antes de editar a interface. Este é o contrato visual do projeto; referências externas são complementares.`
    : 'Antes de editar a interface, consulte AGENTS.md e procure DESIGN.md ou .context/docs/design-system.md. Se não houver contrato aplicado, consulte o catálogo de referências autorizado pelo projeto e informe a referência escolhida.';
  return `${prompt}\n\nRegra de design do projeto (sempre que o trabalho envolver UI):\n${authority}\nReutilize tokens e componentes existentes. Na entrega, identifique a referência usada e como verificou a interface renderizada; se não conseguiu ler ou verificar, declare a limitação. Não apresente uma proposta de design ainda não aplicada como regra vigente.`;
}
