import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_FLAG,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_SQUAD_ID,
  REAL_MISSION_E2E_WORKER_ID,
  createRealMissionE2ESquadFixture,
  isRealMissionE2ERendererFailureSignal,
  isExclusiveRealMissionE2E,
  isRealMissionE2E,
  isRealMissionE2EPreApprovalMission,
  parseRealMissionE2EEvidence,
  realMissionE2ERendererFailureSignal,
  realMissionE2EObservePayloadSchema,
  realMissionE2EPrepareFixturePayloadSchema,
  realMissionE2ERunPayloadSchema,
} from './real-mission-e2e';

const sha = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const rendererFailureToken = 'f'.repeat(64);

function validPassEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'run-e2e',
    appVersion: '0.19.27',
    startedAt: 10,
    finishedAt: 40,
    status: 'pass',
    workspaceSha256: sha('workspace'),
    expectedContentSha256: sha('content'),
    mission: {
      id: 'mission-e2e',
      status: 'done',
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
    },
    kickoff: {
      sessionId: 'session-orch',
      idleAt: 12,
      busyAt: 14,
      ptyDataAt: 15,
      ptyChunkSha256: sha('pty-chunk-without-storing-it'),
    },
    panes: [
      {
        role: 'orchestrator',
        paneId: 'pane-orch',
        sessionId: 'session-orch',
        adapterId: 'codex',
        agentRef: REAL_MISSION_E2E_ORCHESTRATOR_ID,
        workerIncarnationId: null,
        ptySpawnedAt: 11,
        ptyDataAt: 13,
        ptyChunkSha256: sha('orchestrator-physical-pty'),
      },
      {
        role: 'worker',
        paneId: 'pane-worker',
        sessionId: 'session-worker',
        adapterId: 'codex',
        agentRef: REAL_MISSION_E2E_WORKER_ID,
        workerIncarnationId: 'incarnation-worker',
        ptySpawnedAt: 19,
        ptyDataAt: 21,
        ptyChunkSha256: sha('worker-physical-pty'),
      },
    ],
    dispatches: [
      {
        taskId: 'task-worker',
        state: 'completed',
        routeReservationId: 'reservation-worker',
        routeConsumedAt: 20,
        routeConsumerMatches: true,
        workerIncarnationId: 'incarnation-worker',
        sessionId: 'session-worker',
        handoffId: 'handoff-worker',
        handoffAcceptedAt: 25,
        integrationReceipt: {
          kind: 'worktree_integrated',
          referenceSha: 'b'.repeat(40),
          completedAt: 30,
        },
      },
    ],
    handoffs: [
      {
        id: 'handoff-worker',
        status: 'success',
        deliveryState: 'consumed',
        delivered: true,
        acceptedAt: 26,
        acceptedBySessionId: 'session-orch',
      },
    ],
    repository: {
      initialHeadSha: 'a'.repeat(40),
      finalHeadSha: 'b'.repeat(40),
      resultSha256: sha('content'),
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
    failure: null,
  };
}

describe('real mission E2E launch flag', () => {
  it('accepts only the exact explicit flag', () => {
    expect(isRealMissionE2E(['/app', REAL_MISSION_E2E_FLAG])).toBe(true);
    expect(isRealMissionE2E(['/app', `${REAL_MISSION_E2E_FLAG}=1`])).toBe(false);
    expect(isRealMissionE2E(['/app', 'nexus-real-mission-e2e'])).toBe(false);
  });

  it('rejects duplicate and packaged-smoke combinations', () => {
    expect(isExclusiveRealMissionE2E(['/app', REAL_MISSION_E2E_FLAG])).toBe(true);
    expect(
      isExclusiveRealMissionE2E([
        '/app',
        REAL_MISSION_E2E_FLAG,
        REAL_MISSION_E2E_FLAG,
      ]),
    ).toBe(false);
    expect(
      isExclusiveRealMissionE2E([
        '/app',
        REAL_MISSION_E2E_FLAG,
        'nexus-smoke-test',
      ]),
    ).toBe(false);
  });
});

describe('real mission E2E closed receipts', () => {
  it('binds a renderer failure signal to the main-issued 256-bit nonce', () => {
    const signal = realMissionE2ERendererFailureSignal(rendererFailureToken);
    expect(signal).toBe(`renderer-failed:${rendererFailureToken}`);
    expect(
      isRealMissionE2ERendererFailureSignal(signal, rendererFailureToken),
    ).toBe(true);
    expect(
      isRealMissionE2ERendererFailureSignal(signal, 'e'.repeat(64)),
    ).toBe(false);
    expect(
      isRealMissionE2ERendererFailureSignal(
        `${signal}:forged`,
        rendererFailureToken,
      ),
    ).toBe(false);
  });

  it('requires the main-issued failure nonce in the strict run payload', () => {
    expect(
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: '/tmp/nexus-real-workspace',
        rendererFailureToken,
      }),
    ).toEqual({
      workspacePath: '/tmp/nexus-real-workspace',
      rendererFailureToken,
    });
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: '/tmp/nexus-real-workspace',
      }),
    ).toThrow();
    expect(() =>
      realMissionE2ERunPayloadSchema.parse({
        workspacePath: '/tmp/nexus-real-workspace',
        rendererFailureToken: 'predictable',
      }),
    ).toThrow();
  });

  it('binds the main-owned squad fixture to the strict nonce payload', () => {
    expect(
      realMissionE2EPrepareFixturePayloadSchema.parse({
        rendererFailureToken,
      }),
    ).toEqual({ rendererFailureToken });
    expect(() =>
      realMissionE2EPrepareFixturePayloadSchema.parse({
        rendererFailureToken,
        squad: { id: 'forged' },
      }),
    ).toThrow();
    const fixture = createRealMissionE2ESquadFixture();
    expect(fixture).toMatchObject({
      id: REAL_MISSION_E2E_SQUAD_ID,
      builtin: false,
      agents: [
        {
          id: REAL_MISSION_E2E_ORCHESTRATOR_ID,
          category: 'orchestrator',
          cli: 'codex',
          allowedTools: null,
        },
        {
          id: REAL_MISSION_E2E_WORKER_ID,
          category: 'executor',
          cli: 'codex',
          allowedTools: [],
        },
      ],
    });
    expect(fixture.orchestratorInstructions).toContain(
      'orquestração real é do main',
    );
    expect(fixture.orchestratorInstructions).toContain(
      'pode concluir o artefato do worker',
    );
    expect(fixture.orchestratorInstructions).toContain('e2e-worker');
  });

  it('arms observation only for the exact sealed pre-approval fixture', () => {
    const mission = {
      id: 'mission-e2e',
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 1,
      squadId: REAL_MISSION_E2E_SQUAD_ID,
      intentContract: {
        version: 1,
        source: 'automation',
        goal: REAL_MISSION_E2E_GOAL,
        executionMode: 'autopilot',
        lane: 'standard',
        contextPolicy: 'minimal',
        intentVersion: 1,
        acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      },
    } as const;

    expect(isRealMissionE2EPreApprovalMission(mission)).toBe(true);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        status: 'running',
      }),
    ).toBe(false);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        intentContract: {
          ...mission.intentContract,
          approvedAt: 10,
          dispatchedAt: 10,
        },
      }),
    ).toBe(false);
    expect(
      isRealMissionE2EPreApprovalMission({
        ...mission,
        intentContract: {
          ...mission.intentContract,
          goal: 'forged goal',
        },
      }),
    ).toBe(false);
  });

  it('accepts only a strict missionId observation payload', () => {
    expect(
      realMissionE2EObservePayloadSchema.parse({ missionId: 'mission-1' }),
    ).toEqual({ missionId: 'mission-1' });
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({
        missionId: 'mission-1',
        workspacePath: '/forged',
      }),
    ).toThrow();
    expect(() =>
      realMissionE2EObservePayloadSchema.parse({ missionId: '../mission' }),
    ).toThrow();
  });

  it('parses a complete PASS receipt', () => {
    expect(parseRealMissionE2EEvidence(validPassEvidence()).status).toBe('pass');
  });

  it('rejects green evidence without route, handoff, or integration proof', () => {
    const evidence = validPassEvidence();
    evidence.dispatches = [];
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it('rejects durable rows that never came from a physical worker PTY', () => {
    const evidence = validPassEvidence();
    const worker = (evidence.panes as Array<Record<string, unknown>>)[1];
    worker.ptySpawnedAt = null;
    worker.ptyDataAt = null;
    worker.ptyChunkSha256 = null;
    expect(() => parseRealMissionE2EEvidence(evidence)).toThrow(
      /real-mission invariants/,
    );
  });

  it('rejects a stale-session handoff acceptance and a non-exact commit', () => {
    const staleAcceptance = validPassEvidence();
    (
      staleAcceptance.handoffs as Array<Record<string, unknown>>
    )[0].acceptedBySessionId = 'stale-orchestrator-session';
    expect(() => parseRealMissionE2EEvidence(staleAcceptance)).toThrow(
      /real-mission invariants/,
    );

    const extraCommit = validPassEvidence();
    (extraCommit.repository as Record<string, unknown>).commitCount = 3;
    (extraCommit.repository as Record<string, unknown>).exactSingleCommit = false;
    expect(() => parseRealMissionE2EEvidence(extraCommit)).toThrow(
      /real-mission invariants/,
    );
  });

  it('accepts a merge-commit integration (3 commits) when the exact-result invariant holds', () => {
    // The engine may integrate as fast-forward (2 commits) or as a real merge
    // commit (initial + worker result + merge = 3). Either is a PASS as long
    // as exactSingleCommit proved HEAD descends from the initial commit and
    // only resultado.txt changed.
    const mergeCommit = validPassEvidence();
    (mergeCommit.repository as Record<string, unknown>).commitCount = 3;
    expect(() => parseRealMissionE2EEvidence(mergeCommit)).not.toThrow();

    const tooMany = validPassEvidence();
    (tooMany.repository as Record<string, unknown>).commitCount = 4;
    expect(() => parseRealMissionE2EEvidence(tooMany)).toThrow(
      /real-mission invariants/,
    );
  });

  it('keeps failures closed and actionable without raw output fields', () => {
    const evidence = validPassEvidence();
    evidence.status = 'fail';
    const failure = {
      code: 'timeout',
      reason: 'boot_timeout',
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: 'running',
        paneCount: 1,
        dispatchCount: 0,
        handoffCount: 0,
      },
    };
    evidence.failure = failure;
    expect(parseRealMissionE2EEvidence(evidence).status).toBe('fail');
    expect(() =>
      parseRealMissionE2EEvidence({
        ...evidence,
        failure: {
          ...failure,
          reason: 'prompt=private-provider-output',
        },
      }),
    ).toThrow();
    expect(() =>
      parseRealMissionE2EEvidence({
        ...evidence,
        rawOutput: 'must never be persisted',
      }),
    ).toThrow();
  });
});
