import { getOrchSettings } from '../persistence/settings-store';

/**
 * Piloto automático Jev: ligado por padrão; `orch.jevAutopilot === false` ou
 * `NEXUS_JEV_AUTOPILOT=0` desligam. Sem a chave TypeSafe o judge retorna null
 * e nada muda — o flag só controla se o Nexus TENTA chamar o modelo.
 */
export function isJevAutopilotEnabled(): boolean {
  return (
    getOrchSettings().jevAutopilot !== false &&
    process.env.NEXUS_JEV_AUTOPILOT !== '0'
  );
}

/** Lugares onde o piloto automático Jev decide algo. */
export type JevSurface =
  | 'handoffReview'
  | 'intake'
  | 'paneState'
  | 'terminalTriage'
  | 'rank'
  | 'dispatchGuard'
  | 'toolPick'
  | 'taskRouting'
  | 'browserTool'
  | 'researchTriage'
  | 'delegation'
  | 'memoryDistill'
  | 'helperReuse'
  | 'businessModel'
  | 'missionPick'
  | 'catalogPick'
  | 'missionMomentum'
  /** F-1166: surfaces consultivas de fase da missão (nunca bloqueiam). */
  | 'missionKickoff'
  | 'reviewTriage'
  | 'recoveryAdvice'
  | 'completionCheck';

const JEV_SURFACES: readonly JevSurface[] = [
  'handoffReview',
  'intake',
  'paneState',
  'terminalTriage',
  'rank',
  'dispatchGuard',
  'toolPick',
  'taskRouting',
  'browserTool',
  'researchTriage',
  'delegation',
  'memoryDistill',
  'helperReuse',
  'businessModel',
  'missionPick',
  'catalogPick',
  'missionMomentum',
  'missionKickoff',
  'reviewTriage',
  'recoveryAdvice',
  'completionCheck',
];

/**
 * Toggle por superfície: o mestre `jevAutopilot` continua mandando, e cada
 * superfície pode ser desligada isolada por settings
 * (`orch.jevSurfaces.<surface> === false`) ou por env
 * (`NEXUS_JEV_SURFACE_<UPPER>=0`, ex.: `NEXUS_JEV_SURFACE_INTAKE=0`).
 */
export function isJevSurfaceEnabled(surface: JevSurface): boolean {
  if (!isJevAutopilotEnabled()) return false;
  if (process.env[`NEXUS_JEV_SURFACE_${surface.toUpperCase()}`] === '0') {
    return false;
  }
  return getOrchSettings().jevSurfaces?.[surface] !== false;
}

export { JEV_SURFACES };
