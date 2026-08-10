import { createHash } from 'node:crypto';

import {
  isMissionRuntimeSquadId,
  type Squad,
  type SquadAgent,
} from '../shared/orch-types';
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_SQUAD_ID,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EOrchestratorCli,
} from '../shared/real-mission-e2e';
import { snapshotSquadAuthority } from './orch/squad-authority-snapshot';
import {
  applyPreparedSquadSave,
  getSquad,
  prepareSquadSave,
  type PreparedSquadSave,
} from './orch/squad-store';

interface RealMissionE2EFixturePersistence {
  prepareSquadSave(raw: unknown): PreparedSquadSave;
  applyPreparedSquadSave(candidate: PreparedSquadSave): Squad;
  getSquad(id: string): Squad | null;
}

const productionPersistence: RealMissionE2EFixturePersistence = {
  prepareSquadSave,
  applyPreparedSquadSave,
  getSquad,
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function preparedFixtureIsInternallyConsistent(
  candidate: PreparedSquadSave,
): boolean {
  return (
    candidate.squad.id === REAL_MISSION_E2E_SQUAD_ID &&
    candidate.canonicalJson === JSON.stringify(candidate.squad) &&
    candidate.canonicalSha256 === sha256(candidate.canonicalJson) &&
    candidate.snapshot.hash === snapshotSquadAuthority(candidate.squad).hash
  );
}

/**
 * Installs one compiled release-gate fixture through the main-owned store.
 * No renderer bytes choose the squad. The ordinary squad-save IPC and its
 * native confirmation remain untouched. Advisors sem credencial (env
 * NEXUS_REAL_MISSION_ADVISOR_SKIP) ficam fora do roster compilado.
 */
export function persistRealMissionE2ESquadFixture(
  persistence: RealMissionE2EFixturePersistence = productionPersistence,
): Squad {
  const prepared = persistence.prepareSquadSave(
    createRealMissionE2ESquadFixture(
      realMissionE2EAdvisorSkipClis(),
      realMissionE2EOrchestratorCli(),
    ),
  );
  if (!preparedFixtureIsInternallyConsistent(prepared)) {
    throw new Error('real mission fixture preparation hash is inconsistent');
  }

  persistence.applyPreparedSquadSave(prepared);
  const reread = persistence.getSquad(REAL_MISSION_E2E_SQUAD_ID);
  if (
    !reread ||
    sha256(JSON.stringify(reread)) !== prepared.canonicalSha256 ||
    snapshotSquadAuthority(reread).hash !== prepared.snapshot.hash
  ) {
    throw new Error('real mission fixture reread did not match compiled hashes');
  }
  return reread;
}

export function isExactRealMissionE2ESquadFixture(
  candidate: Squad | null | undefined,
): candidate is Squad {
  if (!candidate) return false;
  const expected = createRealMissionE2ESquadFixture(
    realMissionE2EAdvisorSkipClis(),
    realMissionE2EOrchestratorCli(),
  );
  return (
    sha256(JSON.stringify(candidate)) === sha256(JSON.stringify(expected)) &&
    snapshotSquadAuthority(candidate).hash ===
      snapshotSquadAuthority(expected).hash
  );
}

export interface RealMissionE2ESquadBinding {
  readonly squadId: string;
  readonly fixtureSquadId: typeof REAL_MISSION_E2E_SQUAD_ID;
  readonly fixtureSquadRevisionHash: string;
  /** Actual persisted runtimeSourceSquadId, never a logical alias. */
  readonly sourceSquadId: string;
  /** Actual persisted runtimeSourceSquadRevisionHash. */
  readonly sourceSquadRevisionHash: string;
  readonly squadRevisionHash: string;
}

function agentAuthorityShape(agent: SquadAgent): Record<string, unknown> {
  return {
    id: agent.id,
    agentName: agent.agentName,
    category: agent.category,
    cli: agent.cli,
    model: agent.model,
    effort: agent.effort,
    instructions: agent.instructions,
    allowedSkills: agent.allowedSkills,
    allowedTools: agent.allowedTools,
  };
}

function exactRuntimeRoster(candidate: Squad, source: Squad): boolean {
  return (
    candidate.agents.length === source.agents.length &&
    candidate.agents.every(
      (agent, index) =>
        JSON.stringify(agentAuthorityShape(agent)) ===
        JSON.stringify(agentAuthorityShape(source.agents[index]!)),
    )
  );
}

function runtimeBinding(
  candidate: Squad,
  fixture: Squad,
  sourceSquadId: string,
  sourceSquadRevisionHash: string,
): RealMissionE2ESquadBinding {
  return {
    squadId: candidate.id,
    fixtureSquadId: REAL_MISSION_E2E_SQUAD_ID,
    fixtureSquadRevisionHash: snapshotSquadAuthority(fixture).hash,
    sourceSquadId,
    sourceSquadRevisionHash,
    squadRevisionHash: snapshotSquadAuthority(candidate).hash,
  };
}


const CANONICAL_SETUP_SOURCE_ID =
  /^custom-mission-setup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalSetupSource(input: {
  readonly sourceSquadId: string;
  readonly title: string;
  readonly objective: string;
  readonly roster: readonly SquadAgent[];
}): Squad {
  return {
    id: input.sourceSquadId,
    name: `Equipe — ${input.title.trim().slice(0, 512)}`.slice(0, 256),
    createdAt: 'canonical-mission-setup-source',
    builtin: false,
    orchestratorInstructions: [
      '# Missão aprovada no Nexus',
      'Coordene somente o objetivo e os limites persistidos no contrato da missão.',
      'Delegue pelos papéis da equipe e exija evidência antes de concluir.',
      '',
      input.objective,
    ].join('\n'),
    agents: input.roster.map((agent) => ({ ...agent })),
  };
}

/**
 * Resolve the runtime minted by canonical mission.prepare. The ephemeral
 * custom-mission-setup source is not stored, but main persists its exact
 * authority hash on the runtime. Reconstruct every retained source field and
 * accept that hash only when the runtime roster/playbook is byte-exact.
 */
export function resolveCanonicalRealMissionE2ESquadBinding(
  input: {
    readonly squadId: string;
    readonly title: string;
    readonly objective: string;
  },
  lookup: (id: string) => Squad | null = getSquad,
): RealMissionE2ESquadBinding | null {

  const fixture = lookup(REAL_MISSION_E2E_SQUAD_ID);
  const candidate = lookup(input.squadId);
  const sourceSquadId = candidate?.runtimeSourceSquadId;
  if (
    !isExactRealMissionE2ESquadFixture(fixture) ||
    !candidate ||
    !isMissionRuntimeSquadId(candidate.id) ||
    typeof sourceSquadId !== 'string' ||
    !CANONICAL_SETUP_SOURCE_ID.test(sourceSquadId) ||
    typeof candidate.runtimeSourceSquadRevisionHash !== 'string'
  ) {
    return null;
  }

  const expectedSource = canonicalSetupSource({
    sourceSquadId,
    title: input.title,
    objective: input.objective,
    roster: fixture.agents,
  });
  const expectedSourceRevisionHash =
    snapshotSquadAuthority(expectedSource).hash;
  if (
    candidate.runtimeSourceSquadRevisionHash !==
      expectedSourceRevisionHash ||
    candidate.name !== expectedSource.name ||
    candidate.nativeInstructions !== expectedSource.nativeInstructions ||
    candidate.orchestratorInstructions !==
      expectedSource.orchestratorInstructions ||
    !exactRuntimeRoster(candidate, expectedSource)
  ) {
    return null;
  }
  return runtimeBinding(
    candidate,
    fixture,
    sourceSquadId,
    expectedSourceRevisionHash,
  );
}
