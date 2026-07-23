import type { MissionRouteTrace } from '../../shared/orch-types';

const TIER_LABELS: Record<MissionRouteTrace['tier'], string> = {
  trivial: 'trivial',
  easy: 'fácil',
  medium: 'média',
  hard: 'difícil',
  critical: 'crítica',
};

const STATE_LABELS: Record<MissionRouteTrace['state'], string> = {
  reserved: 'reservada',
  consumed: 'usada',
  expired: 'expirada',
};

function bounded(value: string, max: number): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function missionRouteDisplay(
  route: MissionRouteTrace | undefined,
): { meta: string; title: string } | null {
  if (!route) return null;
  const target = route.model
    ? `${route.adapterId}/${route.model}`
    : route.adapterId;
  return {
    meta: `rota ${target} · ${TIER_LABELS[route.tier]} · ${STATE_LABELS[route.state]}`,
    title:
      `Rota Nexus: ${target}` +
      `${route.effort ? ` · effort ${route.effort}` : ''}` +
      ` · tier ${TIER_LABELS[route.tier]} · ${STATE_LABELS[route.state]}\n` +
      `Tarefa: ${bounded(route.taskPreview, 180)}\n` +
      `Decisão: ${bounded(route.reason, 300)}`,
  };
}
