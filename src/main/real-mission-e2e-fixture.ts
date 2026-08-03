import { createHash } from 'node:crypto';

import {
  isMissionRuntimeSquadId,
  type Squad,
  type SquadAgent,
} from '../shared/orch-types';
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EOrchestratorCli,
} from '../shared/real-mission-e2e';
import { retargetSquadInstructions } from '../shared/mission-identity';
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
  readonly sourceSquadId: typeof REAL_MISSION_E2E_SQUAD_ID;
  readonly sourceSquadRevisionHash: string;
  readonly squadRevisionHash: string;
}

function agentAuthorityShape(agent: SquadAgent): Record<string, unknown> {
  return {
    id: agent.id,
    agentName: agent.agentName,
    category: agent.category,
    cli: agent.cli,
    effort: agent.effort,
    allowedSkills: agent.allowedSkills,
    allowedTools: agent.allowedTools,
  };
}

function exactWizardRuntimeRoster(
  candidate: Squad,
  source: Squad,
): boolean {
  return (
    candidate.agents.length === source.agents.length &&
    candidate.agents.every(
      (agent, index) =>
        JSON.stringify(agentAuthorityShape(agent)) ===
        JSON.stringify(agentAuthorityShape(source.agents[index]!)),
    )
  );
}

export function resolvePrivateRealMissionE2ESquadBinding(
  lookup: (id: string) => Squad | null = getSquad,
): RealMissionE2ESquadBinding | null {
  const source = lookup(REAL_MISSION_E2E_SQUAD_ID);
  if (!isExactRealMissionE2ESquadFixture(source)) return null;
  const revisionHash = snapshotSquadAuthority(source).hash;
  return {
    squadId: source.id,
    sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadRevisionHash: revisionHash,
    squadRevisionHash: revisionHash,
  };
}

/**
 * Resolve only the immutable runtime copy minted by main from the exact E2E
 * source roster. Model choice may vary, but executable identities, CLIs,
 * capability policies and playbook remain exactly bound to the fixture.
 *
 * The runtime lineage may pass through ONE operator copy of the fixture
 * ("Salvar configuração" on the review screen mints a `squad-*` user copy and
 * reselects it before launch). That copy is accepted only when its authority
 * bytes — name, instructions and the full reviewed roster — hash exactly to
 * the compiled fixture with the id normalized; any content drift still fails
 * closed.
 */
export function resolveProductWizardRealMissionE2ESquadBinding(
  squadId: string,
  lookup: (id: string) => Squad | null = getSquad,
): RealMissionE2ESquadBinding | null {
  const source = lookup(REAL_MISSION_E2E_SQUAD_ID);
  const candidate = lookup(squadId);
  if (
    !isExactRealMissionE2ESquadFixture(source) ||
    !candidate ||
    !isMissionRuntimeSquadId(candidate.id)
  ) {
    return null;
  }
  const sourceRevisionHash = snapshotSquadAuthority(source).hash;
  const candidateRevisionHash = snapshotSquadAuthority(candidate).hash;
  const lineageIsFixture =
    candidate.runtimeSourceSquadId === REAL_MISSION_E2E_SQUAD_ID &&
    candidate.runtimeSourceSquadRevisionHash === sourceRevisionHash;
  const lineageIsExactOperatorCopy = (): boolean => {
    if (typeof candidate.runtimeSourceSquadId !== 'string') return false;
    const intermediate = lookup(candidate.runtimeSourceSquadId);
    if (!intermediate || isMissionRuntimeSquadId(intermediate.id)) {
      return false;
    }
    return (
      candidate.runtimeSourceSquadRevisionHash ===
        snapshotSquadAuthority(intermediate).hash &&
      snapshotSquadAuthority({
        ...intermediate,
        id: REAL_MISSION_E2E_SQUAD_ID,
        orchestratorInstructions: source.orchestratorInstructions,
      }).hash === sourceRevisionHash
    );
  };
  if (
    (!lineageIsFixture && !lineageIsExactOperatorCopy()) ||
    candidate.name !== source.name ||
    candidate.nativeInstructions !== source.nativeInstructions ||
    (candidate.orchestratorInstructions !== source.orchestratorInstructions &&
      candidate.orchestratorInstructions !==
        retargetSquadInstructions(
          source.orchestratorInstructions,
          REAL_MISSION_E2E_GOAL,
        )) ||
    !exactWizardRuntimeRoster(candidate, source)
  ) {
    return null;
  }
  return {
    squadId: candidate.id,
    sourceSquadId: REAL_MISSION_E2E_SQUAD_ID,
    sourceSquadRevisionHash: sourceRevisionHash,
    squadRevisionHash: candidateRevisionHash,
  };
}
