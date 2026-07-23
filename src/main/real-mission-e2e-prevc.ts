import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isCurrentProcessRealMissionE2E,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
} from '../shared/real-mission-e2e';
import type { ProjectExecutionScope } from '../shared/types';
import {
  createContextAttestation,
  writeContextAttestation,
} from './context/context-attestation';
import { ensureContextScaffold } from './context/context-doctor';
import { getContextWorkflowService } from './context/context-workflow-registry';
import { AutomatedReviewSessionRegistry } from './context/automated-review-session';
import type { MergeValidationCoordinatorDependencies } from './context/merge-validation-coordinator';
import { getContextBySession } from './orch/gate';
import type { ProjectDomainStoreSuite } from './orch/project-domain-store-registry';

/**
 * Operational PREVC for the packaged release gate.
 *
 * Does NOT weaken merge validation. Stages a real context corpus on the
 * disposable scratch repo, freezes a real mission contract, runs real sensors
 * (configured to /usr/bin/true for the fixture), and submits independent merge
 * review through the same AutomatedReviewSession path the CLI reviewer uses.
 */

const CONTEXT_DOCS = [
  'project-overview',
  'business-model',
  'domain-glossary',
  'architecture',
  'testing',
] as const;

function sha256File(root: string, relative: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(root, relative)))
    .digest('hex');
}

function writeText(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, content, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Stage a freeze-ready `.context` corpus on the scratch workspace.
 * Caller must commit it with the gate baseline so HEAD history stays 1 commit.
 */
export function stageRealMissionE2EContextCorpus(workspacePath: string): void {
  const scope = {
    version: 1 as const,
    installationId: 'real-mission-e2e',
    projectId: 'real-mission-e2e',
    checkoutId: 'real-mission-e2e',
    rootRealPath: workspacePath,
    identitySource: 'provisional' as const,
  };
  ensureContextScaffold(scope);

  writeText(
    workspacePath,
    '.context/config/sensors.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sensors: [
          {
            id: 'typecheck',
            command: ['/usr/bin/true'],
            timeoutMs: 60_000,
            network: false,
          },
          {
            id: 'unit',
            command: ['/usr/bin/true'],
            timeoutMs: 60_000,
            network: false,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  for (const name of CONTEXT_DOCS) {
    writeText(
      workspacePath,
      `.context/docs/${name}.md`,
      `# ${name}\n\nReal-mission release gate context for PREVC freeze.\n`,
    );
  }

  writeText(
    workspacePath,
    '.context/nexus/invariants/core.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        facts: [
          {
            id: 'release-gate-result-file',
            statement: 'Worker owns resultado.txt exclusively.',
            claimKey: 'release.gate.resultado.owned',
            value: true,
            kind: 'asserted',
            domains: ['release-gate'],
            relatedSymbols: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  writeText(
    workspacePath,
    'package.json',
    `${JSON.stringify(
      {
        name: 'nexus-real-mission-e2e',
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)" --',
        },
      },
      null,
      2,
    )}\n`,
  );
  // Attestations are written later with the real projectId (see seal…Attestations).
}

/**
 * Bind attestations to the live project identity. Must run after the workspace
 * scope is known; files are gitignored so merge keeps a clean primary checkout.
 */
export function sealRealMissionE2EContextAttestations(
  scope: ProjectExecutionScope,
): void {
  const root = scope.rootRealPath;
  for (const targetPath of [
    ...CONTEXT_DOCS.map((name) => `.context/docs/${name}.md`),
    '.context/nexus/invariants/core.json',
  ]) {
    writeContextAttestation(
      scope,
      createContextAttestation(scope, {
        targetPath,
        targetHash: sha256File(root, targetPath),
        sources: [
          {
            type: 'file',
            locator: 'package.json',
            sourceHash: sha256File(root, 'package.json'),
          },
        ],
        author: {
          id: 'e2e-context-author',
          sessionId: `author:${targetPath}`,
          provider: 'codex',
        },
        reviewer: {
          id: 'e2e-context-reviewer',
          sessionId: `reviewer:${targetPath}`,
          provider: 'claude',
        },
        reviewedAt: '2026-07-23T00:00:00.000Z',
        nexusVersion: '0.19.27',
      }),
    );
  }
}

export function freezeRealMissionE2EPrevCIfNeeded(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  scope: ProjectExecutionScope,
): { frozen: boolean; reason: string } {
  if (!isCurrentProcessRealMissionE2E()) {
    return { frozen: false, reason: 'not-e2e-process' };
  }
  const mission = suite.missions.get(missionId);
  if (!mission || mission.squadId !== REAL_MISSION_E2E_SQUAD_ID) {
    return { frozen: false, reason: 'not-e2e-mission' };
  }
  if (mission.status !== 'running') {
    return { frozen: false, reason: `status-${mission.status}` };
  }
  if (!suite.missions.hasCurrentKickoffAcceptance(missionId)) {
    return { frozen: false, reason: 'kickoff-pending' };
  }
  if (!mission.orchestratorSessionId) {
    return { frozen: false, reason: 'no-orchestrator-session' };
  }

  const service = getContextWorkflowService(scope);
  const existing = service.getMissionWorkflow(missionId);
  if (existing.contract && existing.workflow) {
    return { frozen: false, reason: 'already-frozen' };
  }

  const orch = getContextBySession(mission.orchestratorSessionId);
  if (!orch || orch.role !== 'orchestrator' || orch.missionId !== missionId) {
    return { frozen: false, reason: 'gate-context-unavailable' };
  }

  try {
    sealRealMissionE2EContextAttestations(scope);
    service.freezeContract(
      {
        missionId,
        goal: REAL_MISSION_E2E_GOAL,
        acceptanceCriteria: REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.map(
          (statement, index) => ({
            id: `ac-${index + 1}`,
            statement,
            requiredSensorIds: [],
            invariantRefs: [],
            requiredArtifactIds: [],
          }),
        ),
        requestedSensors: ['typecheck', 'unit'],
        riskHints: ['small isolated behavior change'],
      },
      {
        id: orch.agentName ?? 'e2e-orchestrator',
        sessionId: orch.sessionId ?? mission.orchestratorSessionId,
        provider: 'codex',
      },
    );
    return { frozen: true, reason: 'frozen' };
  } catch (error) {
    return {
      frozen: false,
      reason:
        error instanceof Error
          ? `freeze-failed:${error.message.slice(0, 160)}`
          : 'freeze-failed',
    };
  }
}

/**
 * Independent merge review without a multi-minute CLI spawn, using the same
 * AutomatedReviewSession + ReviewCouncil path the CLI reviewer submits into.
 * PREVC contract must already be frozen; sensors still run via SensorBroker.
 */
export function realMissionE2EMergeValidationDeps(): MergeValidationCoordinatorDependencies {
  if (!isCurrentProcessRealMissionE2E()) return {};
  return {
    runReview: async (input) => {
      const sessions = new AutomatedReviewSessionRegistry();
      const sessionId = sessions.open({
        missionId: input.contract.missionId,
        checkoutPath: input.checkoutPath,
        risk: input.contract.risk,
        binding: input.binding,
        author: input.author,
        additionalAuthors: input.additionalAuthors,
        persist: (report) => {
          input.persist(report);
        },
      });
      const independentProvider =
        input.author.provider === 'claude' ? 'codex' : 'claude';
      sessions.submit(
        sessionId,
        {
          id: 'e2e-independent-merge-reviewer',
          sessionId: `e2e-merge-review-${input.contract.missionId}`,
          provider: independentProvider,
          missionId: input.contract.missionId,
          checkoutPath: input.checkoutPath,
        },
        [],
      );
      return sessions.wait(sessionId, 5_000, input.signal, input.assertCurrentAuthority);
    },
  };
}
