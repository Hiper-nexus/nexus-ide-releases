import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { AgentGateContext } from './gate';
import { buildContextTools } from './tools-context';

const doctorMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../context/context-bootstrap-autopilot', () => ({
  runContextBootstrapAutopilot: doctorMocks.run,
}));

const reviewerMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../context/cli-context-draft-reviewer', async () => {
  const actual = await vi.importActual<
    typeof import('../context/cli-context-draft-reviewer')
  >('../context/cli-context-draft-reviewer');
  return {
    ...actual,
    CliContextDraftReviewer: class {
      run = reviewerMocks.run;
    },
  };
});

let baseDir = '';
let root = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

function context(
  providerId: string,
  sessionId: string,
  role: AgentGateContext['role'] = 'orchestrator',
): AgentGateContext {
  return {
    token: `token-${sessionId}`,
    label: providerId,
    role,
    sessionId,
    agentName: `${providerId}-agent`,
    providerId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildContextTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-tools-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-tools-')));
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-tools',
    projectId: 'project-tools',
    checkoutId: 'checkout-tools',
    rootRealPath: root,
    identitySource: 'manifest',
  });
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureContextWorkflowRegistry(manager, { appVersion: 'test' });
  ensureContextScaffold(scope);
});

afterEach(() => {
  disposeContextWorkflowRegistry();
  manager.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('native context knowledge MCP tools', () => {
  it('exposes the autonomous context and recoverable merge control surface', () => {
    expect(buildContextTools().map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'nexus_context_draft_propose',
        'nexus_system_doctor',
        'nexus_context_draft_review',
        'nexus_context_draft_review_run',
        'nexus_context_draft_apply',
        'nexus_context_commit',
        'nexus_workflow_prepare_execution',
        'nexus_merge_status',
        'nexus_merge_retry',
      ]),
    );
  });

  it('publishes the complete contract criterion schema instead of an opaque object', () => {
    const schema = tool('nexus_mission_freeze_contract').inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.acceptanceCriteria).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: expect.objectContaining({
          statement: { type: 'string' },
          requiredArtifactIds: { type: 'array', items: { type: 'string' } },
        }),
      },
    });
  });

  it('accepts legacy description criteria and human artifact labels before workflow gates', async () => {
    const missionId = 'legacy-contract-mission';
    manager.open(scope).db.prepare(
      `INSERT INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, 'Legacy contract', '', 'active', '[]', 1, 1)`,
    ).run(missionId);

    let failure: unknown;
    try {
      await tool('nexus_mission_freeze_contract').handler({
        missionId,
        goal: 'Exercise backwards-compatible contract parsing.',
        impactedDomains: ['context'],
        impactedSymbols: ['ContextKnowledgeService'],
        acceptanceCriteria: [{
          description: 'The legacy orchestrator can freeze a valid contract.',
          requiredArtifactIds: ['full test report'],
        }],
        requiredArtifacts: ['functional smoke report.md'],
      }, {
        ...context('codex', 'legacy-contract-session', 'orchestrator'),
        missionId,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(
      /expected string, received undefined|unrecognized key.*description|invalid_format/i,
    );
  });

  it('keeps proposal read-only until an independent provider approves it', async () => {
    const source = '# Product source\nRun unit tests.\n';
    fs.writeFileSync(path.join(root, 'README.md'), source);
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\nRun unit tests.\n',
      expectedTargetHash: null,
      sources: [{
        type: 'file',
        locator: 'README.md',
        sourceHash: createHash('sha256').update(source).digest('hex'),
      }],
    }, context('codex', 'author-session')) as { id: string };

    expect(fs.existsSync(path.join(root, '.context/docs/testing.md'))).toBe(false);
    await expect(tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'Self approval.',
    }, context('codex', 'author-session'))).rejects.toThrow(/independent/i);

    await expect(tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'The target matches the independently inspected source.',
    }, context('claude', 'reviewer-session', 'worker'))).resolves.toMatchObject({
      status: 'approved',
    });
    await expect(tool('nexus_context_draft_apply').handler({
      draftId: proposed.id,
    }, context('codex', 'orchestrator-session'))).resolves.toMatchObject({
      draft: expect.objectContaining({ status: 'applied' }),
    });
    expect(fs.readFileSync(path.join(root, '.context/docs/testing.md'), 'utf8'))
      .toContain('Run unit tests');
  });

  it('computes sourceHash and target binding server-side when omitted', async () => {
    // Agentes hospedados não têm tool de hash — exigir sha256 deles era um
    // beco sem saída (o orquestrador não conseguia propor contexto nenhum).
    const source = '# Fonte real\nConteúdo verificável.\n';
    fs.writeFileSync(path.join(root, 'README.md'), source);
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/architecture.md',
      content: '# Arquitetura\nDerivada do README.\n',
      sources: [{ type: 'file', locator: 'README.md' }],
    }, context('codex', 'author-session')) as {
      id: string;
      sources: readonly { sourceHash: string }[];
    };

    expect(proposed.sources[0].sourceHash).toBe(
      createHash('sha256').update(source).digest('hex'),
    );

    await expect(tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'Fontes re-verificadas pelo Nexus a partir do disco.',
    }, context('claude', 'reviewer-session', 'worker'))).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it('still rejects a source hash that does not match the workspace file', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# Fonte\n');
    await expect(tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\n',
      sources: [{
        type: 'file',
        locator: 'README.md',
        sourceHash: 'f'.repeat(64),
      }],
    }, context('codex', 'author-session'))).rejects.toThrow(
      /hash changed or is false/i,
    );
  });

  it('reports an in-flight review as pending instead of failing on timeout', async () => {
    const source = '# Fonte\n';
    fs.writeFileSync(path.join(root, 'README.md'), source);
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\n',
      sources: [{ type: 'file', locator: 'README.md' }],
    }, context('codex', 'author-session')) as { id: string };

    reviewerMocks.run.mockRejectedValue(
      new Error('context draft review timed out'),
    );

    await expect(tool('nexus_context_draft_review_run').handler({
      draftId: proposed.id,
    }, context('codex', 'orchestrator-session'))).resolves.toMatchObject({
      pending: true,
      status: 'proposed',
      reason: expect.stringContaining('nexus_context_draft_get'),
    });
  });

  it('does not materialize an approved draft after async caller authority is revoked', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# Fonte vinculada\n');
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/revoked-review.md',
      content: '# Não aplicar após revogação\n',
      sources: [{ type: 'file', locator: 'README.md' }],
    }, context('codex', 'revoked-author')) as { id: string };

    let resolveReview!: (value: unknown) => void;
    reviewerMocks.run.mockReturnValue(new Promise((resolve) => {
      resolveReview = resolve;
    }));
    let authorityCurrent = true;
    const pending = tool('nexus_context_draft_review_run').handler(
      { draftId: proposed.id },
      context('codex', 'revoked-orchestrator'),
      {
        assertCurrentAuthority: () => {
          if (!authorityCurrent) throw new Error('session_authority_revoked');
        },
      },
    );
    await vi.waitFor(() => expect(reviewerMocks.run).toHaveBeenCalledOnce());

    const reviewed = await tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'Fonte e conteúdo conferidos de forma independente.',
    }, context('claude', 'revoked-reviewer', 'worker'));
    authorityCurrent = false;
    resolveReview(reviewed);

    await expect(pending).rejects.toThrow('session_authority_revoked');
    expect(
      fs.existsSync(path.join(root, '.context/docs/revoked-review.md')),
    ).toBe(false);
  });

  it('never lets a worker materialize approved authority', async () => {
    await expect(tool('nexus_context_draft_apply').handler({
      draftId: 'draft-a',
    }, context('claude', 'worker-session', 'worker'))).rejects.toThrow(/orchestrator/i);
  });

  it('never lets an author worker mint trusted sensor evidence', async () => {
    await expect(tool('nexus_sensor_run').handler({
      missionId: 'mission-a',
      sensorId: 'unit',
    }, {
      ...context('codex', 'author-worker', 'worker'),
      missionId: 'mission-a',
    })).rejects.toThrow(/only the mission orchestrator/i);
  });

  it('does not queue a manual reviewer while the checkout Doctor is active', async () => {
    const source = '# Source\n';
    fs.writeFileSync(path.join(root, 'README.md'), source);
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/architecture.md',
      content: '# Architecture\nSource bound.\n',
      expectedTargetHash: null,
      sources: [{
        type: 'file',
        locator: 'README.md',
        sourceHash: createHash('sha256').update(source).digest('hex'),
      }],
    }, context('codex', 'author-session')) as { id: string };

    let finishDoctor!: (value: unknown) => void;
    doctorMocks.run.mockReturnValue(new Promise((resolve) => {
      finishDoctor = resolve;
    }));
    const doctorCall = tool('nexus_context_doctor').handler(
      {},
      {
        ...context('codex', 'doctor-session'),
        missionId: 'mission-a',
      },
    );
    await vi.waitFor(() => expect(doctorMocks.run).toHaveBeenCalledOnce());

    await expect(tool('nexus_context_draft_review_run').handler({
      draftId: proposed.id,
    }, context('codex', 'manual-review-session'))).resolves.toMatchObject({
      reviewed: null,
      applied: null,
      pending: true,
      reason: expect.stringMatching(/no duplicate review was queued/i),
    });

    finishDoctor({
      phase: 'proposed',
      readiness: { ready: false, blockers: [], warnings: [], sensorIds: [] },
      orientation: null,
      bootstrapProposals: [],
      proposedDraftIds: [proposed.id],
      draftOutcomes: [],
      appliedDraftIds: [],
      rejectedDraftIds: [],
      commitSha: null,
      quorumAvailable: true,
      autopilotHint: 'continue',
    });
    await doctorCall;
  });

  it('keeps concurrent Doctor flights isolated by mission', async () => {
    const pending: Array<(value: unknown) => void> = [];
    doctorMocks.run.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    const missionA = tool('nexus_context_doctor').handler({}, {
      ...context('codex', 'doctor-a'),
      missionId: 'mission-a',
    });
    const missionB = tool('nexus_context_doctor').handler({}, {
      ...context('codex', 'doctor-b'),
      missionId: 'mission-b',
    });

    await vi.waitFor(() => expect(doctorMocks.run).toHaveBeenCalledTimes(2));
    expect(doctorMocks.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      missionId: 'mission-a',
    }));
    expect(doctorMocks.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      missionId: 'mission-b',
    }));
    await expect(tool('nexus_context_draft_review_run').handler({
      draftId: 'draft-unscoped-retry',
    }, context('codex', 'manual-unscoped'))).resolves.toMatchObject({
      pending: true,
      reason: expect.stringMatching(/no duplicate review was queued/i),
    });

    const result = {
      phase: 'ready',
      readiness: { ready: true, blockers: [], warnings: [], sensorIds: [] },
      orientation: null,
      bootstrapProposals: [],
      proposedDraftIds: [],
      draftOutcomes: [],
      appliedDraftIds: [],
      rejectedDraftIds: [],
      commitSha: null,
      quorumAvailable: true,
      autopilotHint: 'ready',
    };
    pending.forEach((resolve) => resolve(result));
    await Promise.all([missionA, missionB]);
  });
});
