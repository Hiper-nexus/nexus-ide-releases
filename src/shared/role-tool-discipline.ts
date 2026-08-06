/**
 * Disciplina de papel imposta no LAUNCH, não pedida no prompt.
 *
 * Medido no motor do Overclock: o piloto dele não tem Read/Bash/pane_list
 * porque essas tools são removidas no spawn via argv `--disallowedTools`. O
 * orquestrador não deriva para executar porque a capacidade está AUSENTE — não
 * porque um prompt pediu bom comportamento.
 *
 * Mesma família do hook fail-closed e do allowedSkills por pane: garantia
 * ESTRUTURAL em vez de instrucional. Um prompt é um pedido; um argv é um fato.
 *
 * Escopo deliberadamente estreito: nega só o que o papel comprovadamente não
 * deve fazer. Papel desconhecido não restringe nada — restringir por engano
 * quebraria trabalho legítimo, e a autoridade real segue no gate síncrono do
 * `pretool`.
 */

/** Ferramentas de MUTAÇÃO do sistema de arquivos e do shell. */
const WRITE_TOOLS = ['Edit', 'NotebookEdit', 'Write'] as const;
/** Execução arbitrária: é o que transforma um piloto em executor. */
const EXEC_TOOLS = ['Bash', 'BashOutput', 'KillShell'] as const;

export type DisciplinedRole =
  | 'orchestrator'
  | 'reviewer'
  | 'executor'
  | (string & {});

export function disallowedToolsForRole(
  role: DisciplinedRole,
): readonly string[] {
  switch (role) {
    case 'orchestrator':
      // Um piloto que pode editar e rodar shell vira executor na primeira
      // tentação. Ele delega; quem executa é o worker.
      return Object.freeze([...EXEC_TOOLS, ...WRITE_TOOLS].sort());
    case 'reviewer':
      // Revisor lê e roda verificação, mas não corrige — "auditor nunca
      // conserta". Ler continua liberado: revisar sem ler é impossível.
      return Object.freeze([...WRITE_TOOLS].sort());
    case 'executor':
      return Object.freeze([]);
    default:
      return Object.freeze([]);
  }
}
