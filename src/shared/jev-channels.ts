/**
 * Jev (TypeSafe System One) IPC channel names. Dependency-free (no zod / node)
 * so both the sandboxed preload and the main process can import it.
 */

export const JEV_CHANNELS = {
  /** invoke: renderer → main. Status sem segredo (presença, env, stats). */
  status: 'jev:status',
  /** invoke: renderer → main. Store/clear the TypeSafe API key in secure storage. */
  setKey: 'jev:setKey',
  /** invoke: renderer → main. Teste de conexão iniciado pelo usuário (GET /v1/models). */
  test: 'jev:test',
  /** invoke: renderer → main. Últimas decisões do diário Jev (learning loop). */
  decisionsList: 'jev:decisions.list',
  /** invoke: renderer → main. Marca certo/errado numa decisão registrada. */
  decisionsFeedback: 'jev:decisions.feedback',
  /** invoke: renderer → main. Agregados por superfície (chamadas, custo, sugestão). */
  decisionsStats: 'jev:decisions.stats',
  /** send: main → renderer. Hint Jev do estado do pane (surface paneState). */
  paneHint: 'jev:paneHint',
  /** invoke: renderer → main. Desempate de missão falada entre candidatos (surface missionPick). */
  missionPick: 'jev:missionPick',
} as const;
