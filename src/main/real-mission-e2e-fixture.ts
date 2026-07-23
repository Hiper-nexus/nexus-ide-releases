import { createHash } from 'node:crypto';

import type { Squad } from '../shared/orch-types';
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_SQUAD_ID,
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
 * native confirmation remain untouched.
 */
export function persistRealMissionE2ESquadFixture(
  persistence: RealMissionE2EFixturePersistence = productionPersistence,
): Squad {
  const prepared = persistence.prepareSquadSave(
    createRealMissionE2ESquadFixture(),
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
  const expected = createRealMissionE2ESquadFixture();
  return (
    sha256(JSON.stringify(candidate)) === sha256(JSON.stringify(expected)) &&
    snapshotSquadAuthority(candidate).hash ===
      snapshotSquadAuthority(expected).hash
  );
}
