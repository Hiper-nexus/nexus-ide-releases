/**
 * Mensagem do HUD quando a fala de um gatilho da Jarvis (clique, wake word,
 * atalho global) segue o destino "pane focado" e não entra em pane nenhum.
 * Antes era "No focused pane to route the prompt into.", em inglês e sem dizer
 * que o destino da voz é um ajuste: quem clicava na JARVIS esperando conversar
 * com ela não tinha como sair dali.
 */
export function routePromptFailureMessage(hasFocusedPane: boolean): string {
  if (!hasFocusedPane) {
    return 'Nenhum pane focado para receber a fala. Clique num pane, ou mude o destino da voz para "Jarvis" em Ajustes › Voz para conversar com ela.';
  }
  return 'O pane focado não aceitou a fala. Tente de novo; se ele estiver ocupado, espere ele terminar.';
}
