/**
 * Pure squad-edit logic used by the Squad Editor UI. Immutable: never mutates
 * the source. Enforces the one business rule that makes editing safe — a
 * built-in squad is app-managed and re-synced on boot, so any edit to it must
 * become a fresh user-owned COPY (new id, builtin=false); otherwise the change
 * would be silently overwritten on the next launch.
 */

export interface EditableAgent {
  id: string;
  agentName: string;
  category: 'orchestrator' | 'executor' | 'reviewer' | 'scout' | 'architect';
  cli: string;
  model?: string;
  effort?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
}

export interface EditableSquad {
  id: string;
  name: string;
  createdAt: string;
  builtin: boolean;
  orchestratorInstructions: string;
  nativeInstructions?: string;
  agents: EditableAgent[];
}

export interface SquadEditPatch {
  name?: string;
  orchestratorInstructions?: string;
  nativeInstructions?: string;
  agents?: EditableAgent[];
}

function validate(name: string, agents: EditableAgent[]): void {
  if (!name.trim()) throw new Error('o nome do squad não pode ficar vazio');
  if (agents.length === 0) throw new Error('o squad precisa de ao menos um agente');
  // F-1495: o Maestro abre o agente pelo nome (`findAgentInSquad` exige um
  // único casamento exato); nome repetido ou com espaço nas pontas virava
  // "unknown squad agent" no meio da missão.
  const seen = new Map<string, string>();
  for (const agent of agents) {
    const agentName = agent.agentName.trim();
    if (!agentName) throw new Error('Dê um nome a cada agente da equipe.');
    const key = agentName.toLocaleLowerCase('pt-BR');
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `Dois agentes se chamam “${first}”. Dê um nome diferente a cada agente.`,
      );
    }
    seen.set(key, agentName);
  }
  // F-1492: o Main exige exatamente um coordenador ao usar a equipe; dois
  // passavam aqui e a missão recusava depois, sem a pessoa saber por quê.
  const coordinators = agents.filter((a) => a.category === 'orchestrator').length;
  if (coordinators === 0) {
    throw new Error(
      'A equipe precisa de um coordenador (orquestrador): marque um agente como “Coordenar”.',
    );
  }
  if (coordinators > 1) {
    throw new Error(
      `A equipe tem ${coordinators} coordenadores; deixe só um agente como “Coordenar”.`,
    );
  }
}

/**
 * Apply an edit. `newId` is used only when the source is a built-in (edit as
 * copy); user squads keep their id and are edited in place.
 */
export function applySquadEdit(
  source: EditableSquad,
  patch: SquadEditPatch,
  newId: string,
): EditableSquad {
  const name = patch.name ?? source.name;
  const agents = patch.agents ?? source.agents;
  validate(name, agents);
  const asCopy = source.builtin;
  return {
    id: asCopy ? newId : source.id,
    name: name.trim(),
    createdAt: source.createdAt,
    builtin: false,
    orchestratorInstructions:
      patch.orchestratorInstructions ?? source.orchestratorInstructions,
    nativeInstructions: patch.nativeInstructions ?? source.nativeInstructions,
    agents: agents.map((a) => ({ ...a, agentName: a.agentName.trim() })),
  };
}
