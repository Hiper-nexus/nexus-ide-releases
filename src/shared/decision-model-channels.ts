/** Dependency-free channel names for the sandboxed preload. */
export const DECISION_MODEL_CHANNELS = {
  status: 'decisionModels:status',
  setKey: 'decisionModels:setKey',
  test: 'decisionModels:test',
  /** F-1167: custo estimado da calibração (só leitura, sem chamada a provedor). */
  calibrationPlan: 'decisionModels:calibrationPlan',
  /** F-1167: roda a calibração; só com clique do operador ({ confirm: true }). */
  calibrate: 'decisionModels:calibrate',
  /** F-1167: gasto e dicas do motor numa missão do workspace do renderer (só leitura). */
  missionPanel: 'decisionModels:missionPanel',
} as const;
