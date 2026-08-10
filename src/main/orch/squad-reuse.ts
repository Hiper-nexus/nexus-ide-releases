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
  agents: Array<{ cli: string; category?: string; model?: string }>;
}

import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
} from "../../shared/orch-types";
import {
  assessStandardSquadReadiness,
  isSquadRuntimeAgentRoutable,
  squadRuntimeCliPolicyFromRoutableIds,
  type SquadRuntimeCliPolicy,
} from "./squad-runtime-policy";

// O schema de squad aceita epoch-ms OU ISO string em createdAt (ambos viram
// string). Number(ISO) é NaN e quebraria o "mais recente" — parse os dois.
function createdAtMs(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mais recente squad DE USUÁRIO cujo roster inteiro está roteável. Builtin
 * (gerenciados pelo app) e fallbacks agênticos auto-gerados ficam de fora —
 * reusar um fallback velho congelaria exatamente o time que queremos evitar.
 *
 * Doutrina fluxo-por-padrão (2026-08-10): o único gate de forma que sobrou é
 * "exatamente um Maestro" (`assessStandardSquadReadiness`). Evidência de
 * orquestração, completude do roster e qualificação de escrita autônoma
 * deixaram de reprovar o reuso — quem impõe confinamento é a fronteira física
 * de spawn (`assertReleaseQualifiedMissionWorkerSpawn`). Credencial ainda
 * barra aqui: um agente com modelo sem auth pronta não é roteável.
 */
export function pickReusableSquad<T extends ReusableSquadLike>(
  squads: T[],
  runtimePolicy: ReadonlySet<string> | SquadRuntimeCliPolicy,
  verifiedOrchestratorCliIds: ReadonlySet<string>,
  operatorChoice = false,
): T | null {
  const policy =
    typeof runtimePolicy === "object" &&
    runtimePolicy !== null &&
    "routableCliIds" in runtimePolicy
      ? runtimePolicy
      : squadRuntimeCliPolicyFromRoutableIds(runtimePolicy);
  const eligible = squads.filter((squad) => {
    return (
      !squad.builtin &&
      !isEngineGeneratedSquadId(squad.id) &&
      !isMissionRuntimeSquadId(squad.id) &&
      squad.agents.length > 0 &&
      squad.agents.every((agent) =>
        isSquadRuntimeAgentRoutable(agent, policy),
      ) &&
      assessStandardSquadReadiness(
        squad.agents,
        policy,
        verifiedOrchestratorCliIds,
        operatorChoice,
      ).ok
    );
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, squad) =>
    createdAtMs(squad.createdAt) > createdAtMs(latest.createdAt)
      ? squad
      : latest,
  );
}
