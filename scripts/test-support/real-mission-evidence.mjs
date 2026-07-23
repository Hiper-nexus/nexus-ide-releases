import { createHash } from 'node:crypto';

const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');

export function makeValidRealMissionEvidence({
  appVersion = '1.2.3',
  commitSha = 'a'.repeat(40),
  artifactSha256 = sha256('zip'),
  identity =
    'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
} = {}) {
  const finalHeadSha = 'b'.repeat(40);
  const expectedContentSha256 = sha256('nexus-real-mission-e2e-ok\n');
  return {
    schemaVersion: 1,
    status: 'pass',
    failure: null,
    expectedContentSha256,
    release: {
      appVersion,
      runId: '3e112472-c72f-4f5e-b6bd-e9cae5c9c413',
      startedAt: '2026-07-23T10:00:00.000Z',
      finishedAt: '2026-07-23T10:01:00.000Z',
      commitSha,
      artifact: {
        sha256: artifactSha256,
        identity,
      },
    },
    mission: {
      id: 'mission-real',
      status: 'done',
      squadId: 'nexus-real-mission-e2e',
    },
    kickoff: {
      sessionId: 'session-orch',
      idleAt: 1,
      busyAt: 2,
      ptyDataAt: 3,
      ptyChunkSha256: sha256('kickoff-pty'),
    },
    panes: [
      {
        role: 'orchestrator',
        adapterId: 'claude',
        agentRef: 'e2e-orchestrator',
        sessionId: 'session-orch',
      },
      {
        role: 'worker',
        adapterId: 'codex',
        agentRef: 'e2e-worker',
        workerIncarnationId: 'incarnation-worker',
        sessionId: 'session-worker',
        ptySpawnedAt: 4,
        ptyDataAt: 5,
        ptyChunkSha256: sha256('worker-pty'),
      },
    ],
    dispatches: [
      {
        state: 'completed',
        routeReservationId: 'reservation',
        routeConsumedAt: 4,
        routeConsumerMatches: true,
        workerIncarnationId: 'incarnation-worker',
        sessionId: 'session-worker',
        handoffId: 'handoff',
        handoffAcceptedAt: 5,
        integrationReceipt: {
          kind: 'worktree_integrated',
          referenceSha: finalHeadSha,
        },
      },
    ],
    handoffs: [
      {
        id: 'handoff',
        status: 'success',
        delivered: true,
        deliveryState: 'consumed',
        acceptedAt: 6,
        acceptedBySessionId: 'session-orch',
      },
    ],
    repository: {
      initialHeadSha: 'c'.repeat(40),
      finalHeadSha,
      resultSha256: expectedContentSha256,
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
  };
}
