/**
 * Reuso de squad salvo no modo agêntico. Pure logic (sem electron/sqlite) —
 * decide se um squad do usuário pode assumir a missão antes de sintetizar o
 * fallback determinístico, para que o roster configurado (kimi/agy/…) seja
 * honrado em vez de ignorado.
 */

export interface ReusableSquadLike {
  id: string;
  builtin: boolean;
  createdAt: string;
  agents: Array<{ cli: string }>;
}

import { isEngineGeneratedSquadId } from '../../shared/orch-types';

// O schema de squad aceita epoch-ms OU ISO string em createdAt (ambos viram
// string). Number(ISO) é NaN e quebraria o "mais recente" — parse os dois.
function createdAtMs(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mais recente squad DE USUÁRIO cujo roster inteiro está instalado. Builtin
 * (gerenciados pelo app) e fallbacks agênticos auto-gerados ficam de fora —
 * reusar um fallback velho congelaria exatamente o time que queremos evitar.
 * Roster com cli não instalado desqualifica: worker spawnado numa CLI ausente
 * para num prompt de login em missão autônoma.
 */
export function pickReusableSquad<T extends ReusableSquadLike>(
  squads: T[],
  installedCliIds: ReadonlySet<string>,
): T | null {
  const eligible = squads.filter(
    (squad) =>
      !squad.builtin &&
      !isEngineGeneratedSquadId(squad.id) &&
      squad.agents.length > 0 &&
      squad.agents.every((agent) => installedCliIds.has(agent.cli)),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, squad) =>
    createdAtMs(squad.createdAt) > createdAtMs(latest.createdAt) ? squad : latest,
  );
}
