/**
 * Contrato de navegação da retomada (P1-0).
 *
 * O operador foi EJETADO da página dos panes para o assistente de Nova
 * Missão e não teve como voltar — a missão continuava no quadro, mas o
 * trabalho sumiu de vista. A causa é uma decisão de destino tomada por
 * CLASSIFICAÇÃO ("parece um shell armado") antes de ler a evidência
 * ("quantos panes esta missão gravou?").
 *
 * Aqui a ordem se inverte: prova primeiro. Panes gravados mandam no
 * destino, seja qual for o estado de intenção. O assistente é destino
 * legítimo só com prova de zero panes — nunca como fallback de um estado
 * não reconhecido, que é exatamente o caminho de perda-de-trabalho-por-UI.
 * Módulo puro: recebe as contagens já lidas, não consulta store nem IPC.
 */
export type MissionResumeRoute =
  | { readonly kind: 'panes'; readonly recordedPanes: number; readonly live: boolean }
  | { readonly kind: 'wizard' }
  | { readonly kind: 'stay'; readonly notice: string };

export interface MissionResumeRouteInput {
  /** Panes desta missão vivos no layout agora. */
  readonly livePanes: number;
  /** Panes que a missão gravou (composição persistida). */
  readonly recordedPanes: number;
  /** Rascunho armado de modo agêntico — nasceu sem panes de propósito. */
  readonly isArmedShell: boolean;
  /**
   * Itens de plano/fila que a missão já selou. É a prova de trabalho que
   * SOBREVIVE quando todo sinal de pane morre: no voo de 05/08
   * (mission-3be48989) `mission_panes` ficou vazio, `orch_session_id` NULL e
   * `intentContract.dispatchedAt` sumiu na recompilação do intent — e mesmo
   * assim havia 8 tasks e um plano selado no banco. Sem isto, "sem panes"
   * é lido como "nunca começou".
   */
  readonly plannedWork?: number;
}

/** Destino de "Retomar", decidido por evidência e não por classificação. */
export function missionResumeRoute(
  input: MissionResumeRouteInput,
): MissionResumeRoute {
  if (input.livePanes > 0) {
    return { kind: 'panes', recordedPanes: input.recordedPanes, live: true };
  }
  // Panes gravados existem: reabrir é reabrir OS PANES. Um estado de intenção
  // que discorde disso está desatualizado, e desatualizado não pode ejetar o
  // operador do trabalho dele.
  if (input.recordedPanes > 0) {
    return { kind: 'panes', recordedPanes: input.recordedPanes, live: false };
  }
  // Plano selado é trabalho, e trabalho nunca autoriza o assistente. Sem panes
  // não há o que reabrir, mas a resposta certa é ficar na página dizendo o que
  // existe — jamais oferecer a tela de quem nunca planejou.
  const planned = input.plannedWork ?? 0;
  if (planned > 0) {
    return {
      kind: 'stay',
      notice:
        `Esta missão parou sem panes gravados, mas o plano com ${planned} ` +
        'tarefa(s) e o trabalho já feito continuam preservados. Abra o ' +
        'diagnóstico da missão para ver por que ela parou antes de recomeçar.',
    };
  }
  if (input.isArmedShell) return { kind: 'wizard' };
  return {
    kind: 'stay',
    notice:
      'Sem panes gravados e sem rascunho armado: não há o que retomar aqui. ' +
      'Use "Nova missão" para começar outra — esta continua no histórico, ' +
      'com fila e bloqueios visíveis.',
  };
}
