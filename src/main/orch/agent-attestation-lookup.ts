/**
 * Look up the latest issued handoff attestation for a mission agent so the
 * MCP handoff boundary can present a Main-held proof (keys live in the vault,
 * not in the worker process).
 */
import type { Database } from 'better-sqlite3';

import type { AgentAttestation } from '../../shared/agent-attestation';
import type { AgentAttestationProof } from './agent-attestation-gate';
import { NEXUS_ATTESTATION_KIND } from '../../shared/agent-attestation';

export function lookupIssuedHandoffAttestation(
  db: Database,
  missionId: string,
  agentId: string,
  atSeconds: number,
): AgentAttestationProof | null {
  const table = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master
       WHERE type = 'table' AND name = 'mission_agent_attestations'`,
    )
    .get() as { ok: number } | undefined;
  if (!table) return null;

  const row = db
    .prepare(
      `SELECT credential_json
       FROM mission_agent_attestations
       WHERE mission_id = ? AND agent_id = ?
       ORDER BY issued_at DESC
       LIMIT 1`,
    )
    .get(missionId, agentId) as { credential_json: string } | undefined;
  if (!row) return null;
  let credential: AgentAttestation;
  try {
    credential = JSON.parse(row.credential_json) as AgentAttestation;
  } catch {
    return null;
  }
  if (
    !Array.isArray(credential) ||
    credential.length !== 4 ||
    credential[0] !== 'auth'
  ) {
    return null;
  }
  return {
    agentId,
    credential,
    at: atSeconds,
    kind: NEXUS_ATTESTATION_KIND.handoff,
  };
}
