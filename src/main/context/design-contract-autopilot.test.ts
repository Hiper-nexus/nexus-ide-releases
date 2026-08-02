import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ContextDraftRecord } from './context-draft-store';
import type { ContextReadinessReport } from './context-doctor';

/**
 * The design branch of the bootstrap autopilot, end to end: goal in, applied
 * design authority out, with nobody clicking anything.
 *
 * The workspace is a REAL temp directory because the whole guarantee rests on
 * the contract being a deterministic function of what is on disk. Only the
 * draft store, the orientation map and the CLI reviewer are mocked — mocking
 * the filesystem would test nothing.
 */

interface StoredDraft {
  record: ContextDraftRecord;
}

const mocks = vi.hoisted(() => ({
  readiness: {
    ready: false,
    blockers: [{ code: 'missing-business-context' as const, message: 'missing' }],
    warnings: [],
    sensorIds: [],
  } as ContextReadinessReport,
  inspectReadiness: vi.fn(),
  scaffold: vi.fn(),
  inspectGit: vi.fn(),
  reviewerRun: vi.fn(),
  selectQuorum: vi.fn(),
  commitApplied: vi.fn(),
  onPropose: vi.fn(),
  store: new Map<string, StoredDraft>(),
  nextId: { value: 0 },
}));

vi.mock('./git-binding', () => ({ inspectGitBinding: mocks.inspectGit }));

vi.mock('./orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => null,
}));

vi.mock('./orientation/orientation-bootstrap-context', async () => {
  const actual = await vi.importActual<
    typeof import('./orientation/orientation-bootstrap-context')
  >('./orientation/orientation-bootstrap-context');
  return {
    ...actual,
    // Structural proposals are covered by context-bootstrap-autopilot.test.ts;
    // here the design proposal must stand entirely on its own.
    buildContextBootstrapProposals: () => [],
    isMechanicallyReviewableBootstrapProposal: () => false,
  };
});

vi.mock('./cli-context-draft-reviewer', () => ({
  CliContextDraftReviewer: class {
    run = mocks.reviewerRun;
  },
  selectIndependentContextReviewerRoute: (provider: string) =>
    mocks.selectQuorum(provider),
  CONTEXT_DRAFT_REVIEW_UNAVAILABLE_MESSAGE:
    'context draft auto-review unavailable',
}));

vi.mock('./context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    inspectReadiness: mocks.inspectReadiness,
    scaffold: mocks.scaffold,
  }),
  getContextKnowledgeService: () => knowledgeDouble(),
}));

import { runContextBootstrapAutopilot } from './context-bootstrap-autopilot';

const author = Object.freeze({
  id: 'nexus-guided-preflight',
  sessionId: 'main:mission-1:context',
  provider: 'nexus-main',
});

/**
 * Minimal in-memory stand-in for ContextKnowledgeService that keeps the state
 * transitions the autopilot depends on (propose → review → apply) honest.
 */
function knowledgeDouble() {
  return {
    list: ({ status }: { status?: ContextDraftRecord['status'] } = {}) =>
      [...mocks.store.values()]
        .map((entry) => entry.record)
        .filter((record) => !status || record.status === status),
    get: (id: string) => mocks.store.get(id)?.record ?? null,
    propose: (
      input: {
        missionId: string | null;
        targetPath: string;
        content: string;
        sources: ContextDraftRecord['sources'];
      },
      actor: ContextDraftRecord['author'],
    ) => {
      mocks.nextId.value += 1;
      const id = `draft-${mocks.nextId.value}`;
      const record = Object.freeze({
        id,
        missionId: input.missionId,
        targetPath: input.targetPath,
        content: input.content,
        contentHash: 'c'.repeat(64),
        expectedTargetHash: null,
        sources: Object.freeze([...input.sources]),
        status: 'proposed' as const,
        author: actor,
        reviewer: null,
        reviewRationale: null,
        attestationId: null,
        appliedCommit: null,
        createdAt: 1,
        updatedAt: 1,
        reviewedAt: null,
        appliedAt: null,
      }) as ContextDraftRecord;
      mocks.store.set(id, { record });
      mocks.onPropose(record);
      return record;
    },
    review: (
      id: string,
      input: {
        decision: 'approve' | 'reject';
        reviewer: ContextDraftRecord['author'];
        rationale: string;
      },
    ) => {
      const entry = mocks.store.get(id);
      if (!entry) throw new Error('context draft not found');
      const record = Object.freeze({
        ...entry.record,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewer: input.reviewer,
        reviewRationale: input.rationale,
        reviewedAt: 2,
      }) as ContextDraftRecord;
      mocks.store.set(id, { record });
      return record;
    },
    apply: (id: string) => {
      const entry = mocks.store.get(id);
      if (!entry) throw new Error('context draft not found');
      const record = Object.freeze({
        ...entry.record,
        status: 'applied',
        attestationId: 'att-1',
        appliedAt: 3,
      }) as ContextDraftRecord;
      mocks.store.set(id, { record });
      return { draft: record };
    },
    commitApplied: mocks.commitApplied,
  };
}

const UI_GOAL = 'redesign da interface do dashboard de metricas';

let root: string;
let catalogDir: string;
let scope: ProjectExecutionScope;

function run(overrides: {
  goal?: string | null;
  pinnedKitId?: string | null;
  missionId?: string | null;
  designContract?: null;
} = {}) {
  return runContextBootstrapAutopilot({
    scope,
    author,
    missionId: overrides.missionId ?? 'mission-1',
    autoReview: true,
    autoCommit: false,
    ...(overrides.designContract === null
      ? { designContract: null }
      : {
          designContract: {
            missionGoal: overrides.goal === undefined ? UI_GOAL : overrides.goal,
            pinnedKitId: overrides.pinnedKitId ?? null,
            catalogDir,
          },
        }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.clear();
  mocks.nextId.value = 0;
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-autopilot-')),
  );
  catalogDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-autopilot-kits-')),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'acme-console' }, null, 2)}\n`,
    'utf8',
  );
  scope = Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'provisional',
  }) as ProjectExecutionScope;
  mocks.inspectReadiness.mockReturnValue(mocks.readiness);
  mocks.inspectGit.mockReturnValue({
    baseSha: 'a'.repeat(40),
    headSha: 'a'.repeat(40),
    diffHash: 'b'.repeat(64),
  });
  mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(catalogDir, { recursive: true, force: true });
});

describe('runContextBootstrapAutopilot — design branch', () => {
  it('materializes the design contract for a UI mission with zero clicks', async () => {
    const result = await run();

    expect(result.designContract).toMatchObject({
      targetPath: '.context/docs/design-system.md',
      status: 'applied',
      directionMode: 'neutral',
    });
    expect(result.appliedDraftIds).toHaveLength(1);

    const applied = mocks.store.get(result.appliedDraftIds[0]!)!.record;
    expect(applied.targetPath).toBe('.context/docs/design-system.md');
    expect(applied.content).toContain('# Design contract — acme-console');
    expect(applied.sources[0]?.locator).toBe('package.json');
    // Independent identity, distinct from the author, with a rationale that
    // states exactly what was verified.
    expect(applied.author.id).toBe('nexus-guided-preflight');
    expect(applied.reviewer?.id).toBe('nexus-design-contract-reviewer');
    expect(applied.reviewRationale).toContain('deterministic re-derivation');
    // The CLI reviewer is never involved in a design contract.
    expect(mocks.reviewerRun).not.toHaveBeenCalled();
  });

  it('leads the mission hint with the direction and how it was chosen', async () => {
    fs.writeFileSync(
      path.join(catalogDir, 'panelkit.md'),
      '---\nname: panelkit\ndescription: "A dense dashboard and analytics system with metrics and charts."\n---\n\n# panelkit\n',
      'utf8',
    );

    const result = await run();

    expect(result.designContract?.directionMode).toBe('match');
    expect(result.autopilotHint).toContain('Design contract materialized');
    expect(result.autopilotHint).toContain('`panelkit`');
    expect(result.autopilotHint).toContain('low confidence');
    // The structural hint is preserved, not replaced.
    expect(result.autopilotHint).toContain('readiness still blocked');
  });

  it('does nothing at all for a backend mission', async () => {
    const result = await run({
      goal: 'implementar o endpoint de sincronizacao no servidor',
    });

    expect(result.designContract).toMatchObject({
      status: 'skipped',
      skipReason: 'not-visual-work',
      directionMode: null,
    });
    expect(mocks.store.size).toBe(0);
    expect(result.appliedDraftIds).toEqual([]);
  });

  it('never overwrites a contract the project already has', async () => {
    fs.writeFileSync(path.join(root, 'DESIGN.md'), '# House style\n', 'utf8');

    const result = await run();

    expect(result.designContract).toMatchObject({
      status: 'skipped',
      skipReason: 'contract-exists',
    });
    expect(mocks.store.size).toBe(0);
    expect(fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8')).toBe(
      '# House style\n',
    );
  });

  it('runs even when the structural context is already green', async () => {
    mocks.inspectReadiness.mockReturnValue(
      Object.freeze({
        ready: true,
        blockers: Object.freeze([]),
        warnings: Object.freeze([]),
        sensorIds: Object.freeze([]),
      }) as ContextReadinessReport,
    );

    const result = await run();

    // A green corpus used to short-circuit the whole pilot, which is exactly
    // how a fully documented project still had no design authority.
    expect(result.designContract?.status).toBe('applied');
    expect(result.appliedDraftIds).toHaveLength(1);
  });

  it('steps aside when another author already owns the design target', async () => {
    // A human import (or another mission) proposed different bytes for the
    // same target. Racing it would either lose the UNIQUE index or reject
    // their work under a policy written for a different kind of draft.
    mocks.store.set('foreign', {
      record: Object.freeze({
        id: 'foreign',
        missionId: 'other-mission',
        targetPath: '.context/docs/design-system.md',
        content: '# Imported by hand\n',
        contentHash: 'd'.repeat(64),
        expectedTargetHash: null,
        sources: Object.freeze([]),
        status: 'proposed',
        author,
        reviewer: null,
        reviewRationale: null,
        attestationId: null,
        appliedCommit: null,
        createdAt: 1,
        updatedAt: 1,
        reviewedAt: null,
        appliedAt: null,
      }) as ContextDraftRecord,
    });

    const result = await run();

    expect(result.designContract).toMatchObject({
      status: 'skipped',
      skipReason: 'foreign-active-draft',
    });
    expect(mocks.store.get('foreign')?.record.status).toBe('proposed');
    expect(result.appliedDraftIds).toEqual([]);
  });

  it('rejects instead of approving when the contract stops being reproducible mid-pass', async () => {
    // A contract appears between propose and review: the re-derivation now
    // returns nothing, so the durable draft can no longer be proven.
    mocks.onPropose.mockImplementation(() => {
      fs.writeFileSync(path.join(root, 'DESIGN.md'), '# Raced\n', 'utf8');
    });

    const result = await run();

    expect(result.designContract?.status).toBe('rejected');
    expect(result.rejectedDraftIds).toHaveLength(1);
    const rejected = mocks.store.get(result.rejectedDraftIds[0]!)!.record;
    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewRationale).toContain('design-contract policy');
    expect(result.appliedDraftIds).toEqual([]);
  });

  it('is fully disabled by designContract: null', async () => {
    const result = await run({ designContract: null });

    expect(result.designContract).toBeNull();
    expect(mocks.store.size).toBe(0);
  });
});

/**
 * H6 — EVERY DECISION SPEAKS.
 *
 * The six skip reasons were enum tokens with no prose anywhere in the product:
 * zero occurrences in `src/renderer`, `src/preload` or `src/shared`. They died
 * inside the MCP payload, and `hintFor` only spoke when the status was
 * `applied`. So the operator could not tell "no contract was needed" from "the
 * contract failed to materialize", and M3 (empty folder + "crie a landing da
 * minha clínica") skipped in complete silence.
 */
describe('every design decision is explained to the operator', () => {
  it('says why nothing was created for a non-visual goal', async () => {
    const result = await run({
      goal: 'implementar o endpoint de sincronizacao no servidor',
    });

    const design = result.designContract!;
    expect(design.skipReason).toBe('not-visual-work');
    expect(design.message).toContain('não visual');
    expect(design.message).toContain('nenhuma tarefa desta missão vai exigir');
    // A backend mission does not need design prose on its loudest channel —
    // but the payload still carries it.
    expect(result.autopilotHint).not.toContain('Contrato de design');
  });

  it('explains the low-confidence policy and names both ends of it', async () => {
    const result = await run({ goal: 'trocar a cor do botão de aprovar da fila' });

    const design = result.designContract!;
    expect(design.status).toBe('skipped');
    expect(design.skipReason).toBe('low-confidence');
    expect(design.message).toContain('confiança');
    // The operator is told the deadlock cannot happen, and how to opt in.
    expect(design.message).toContain('design_contract_missing');
    expect(design.message).toContain('mesma régua');
    expect(result.autopilotHint).toContain('Contrato de design');
  });

  it('names the contract it refused to overwrite', async () => {
    fs.writeFileSync(path.join(root, 'DESIGN.md'), '# House style\n', 'utf8');

    const result = await run();

    const design = result.designContract!;
    expect(design.skipReason).toBe('contract-exists');
    expect(design.message).toContain('`DESIGN.md`');
    expect(design.message).toContain('nunca sobrescreve');
    expect(result.autopilotHint).toContain('Contrato de design');
  });

  it('tells M3 that an empty folder recovers on the NEXT pass', async () => {
    // Exactly the measured M3 scenario: nothing to bind yet, because this
    // branch runs before the structural proposals of this pass are applied.
    fs.rmSync(path.join(root, 'package.json'));

    const result = await run({ goal: 'crie a landing page da minha clinica' });

    const design = result.designContract!;
    expect(design.skipReason).toBe('no-bindable-source');
    expect(design.message).toContain('PRÓXIMA');
    expect(design.message).toContain('nexus_context_doctor');
    expect(design.message).toContain('`PRODUCT.md`');
    expect(result.autopilotHint).toContain('Contrato de design');
  });

  it('explains stepping aside for a foreign draft', async () => {
    mocks.store.set('foreign', {
      record: Object.freeze({
        id: 'foreign',
        missionId: 'other-mission',
        targetPath: '.context/docs/design-system.md',
        content: '# Imported by hand\n',
        contentHash: 'd'.repeat(64),
        expectedTargetHash: null,
        sources: Object.freeze([]),
        status: 'proposed',
        author,
        reviewer: null,
        reviewRationale: null,
        attestationId: null,
        appliedCommit: null,
        createdAt: 1,
        updatedAt: 1,
        reviewedAt: null,
        appliedAt: null,
      }) as ContextDraftRecord,
    });

    const result = await run();

    const design = result.designContract!;
    expect(design.skipReason).toBe('foreign-active-draft');
    expect(design.message).toContain('outro autor');
    expect(design.message).toContain('drafts de contexto');
  });

  it('never leaves a decision without prose', async () => {
    for (const goal of [
      UI_GOAL,
      'trocar a cor do botão de aprovar da fila',
      'implementar o endpoint de sincronizacao no servidor',
      'crie o spritesheet do mascote do desktop pet',
      '',
    ]) {
      mocks.store.clear();
      mocks.nextId.value = 0;
      const result = await run({ goal });
      const design = result.designContract!;
      expect(design.message.length).toBeGreaterThan(40);
      // Skips speak Portuguese to the operator; a materialized contract keeps
      // the agent-facing instruction. Neither is ever silent.
      expect(
        design.status === 'skipped'
          ? design.message.includes('Contrato de design')
          : design.message.includes('contract materialized'),
      ).toBe(true);
      // No raw enum ever reaches the operator (L2).
      expect(design.message).not.toMatch(/\bnot-visual-work\b/);
      expect(design.message).not.toMatch(/\blow-confidence\b/);
      expect(design.message).not.toMatch(/\bno-bindable-source\b/);
      expect(design.message).not.toMatch(/\bempty-catalog\b/);
      expect(design.message).not.toMatch(/\bambiguous-match\b/);
      expect(design.message).not.toMatch(/\bno-domain-signal\b/);
    }
  });

  it('writes a human reason instead of interpolating a raw enum (L2)', async () => {
    const result = await run();

    const design = result.designContract!;
    expect(design.status).toBe('applied');
    expect(design.message).toContain(
      'no visual direction was chosen because no visual reference was ' +
        'available to choose from',
    );
    expect(design.message).not.toContain('(empty-catalog)');
    // The draft's own rationale carried the same raw enum.
    const applied = mocks.store.get(result.appliedDraftIds[0]!)!.record;
    expect(applied.targetPath).toBe('.context/docs/design-system.md');
    const proposalRationale = result.bootstrapProposals.find(
      (proposal) => proposal.targetPath === '.context/docs/design-system.md',
    )?.rationale;
    expect(proposalRationale).toContain(
      'no visual direction, because no visual reference was available',
    );
    expect(proposalRationale).not.toContain('(empty-catalog)');
  });
});

/**
 * A1 — A REJECTION MUST NOT BE AN ABSORBING STATE.
 *
 * `reDeriveDesignProposal` swallowed every throw and answered `null`, and
 * `null` meant reject. But `findExistingDesignContractInScope` re-raises
 * anything that is not ENOENT, so a single momentary read failure on DESIGN.md
 * became a DURABLE rejection; the next pass re-derived byte-identical content,
 * matched the rejection memory, recorded `rejected-stable`, and never proposed
 * again — and the "replace a rejected draft" loop excludes design explicitly.
 * The target was blocked forever with no product-level way out.
 */
describe('a transient failure never blocks the design target forever', () => {
  it('does NOT reject when the re-derivation could not run at all', async () => {
    // A directory where DESIGN.md should be: `readIfPresentInScope` re-raises
    // anything that is not ENOENT, which is the transient class this covers.
    mocks.onPropose.mockImplementation(() => {
      fs.mkdirSync(path.join(root, 'DESIGN.md'), { recursive: true });
    });

    const result = await run();

    const design = result.designContract!;
    expect(result.rejectedDraftIds).toEqual([]);
    expect(design.status).not.toBe('rejected');
    // The durable draft is untouched and still reviewable next pass.
    const drafts = [...mocks.store.values()].map((entry) => entry.record);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('proposed');
    expect(design.message).toContain('continua PROPOSTO');
    expect(design.message).toContain('não é prova');
    expect(result.autopilotHint).toContain('Contrato de design');
  });

  it('re-proposes after a genuine rejection instead of going terminal', async () => {
    // Pass 1: a contract appears between propose and review, so the
    // re-derivation runs and legitimately refuses. That is a real rejection.
    mocks.onPropose.mockImplementation(() => {
      fs.writeFileSync(path.join(root, 'DESIGN.md'), '# Raced\n', 'utf8');
    });
    const first = await run();
    expect(first.designContract?.status).toBe('rejected');
    expect(first.rejectedDraftIds).toHaveLength(1);
    expect(first.designContract?.message).toContain('ISENTO da');

    // The racing file goes away; the environment is back to where it was.
    fs.rmSync(path.join(root, 'DESIGN.md'));
    mocks.onPropose.mockImplementation(() => {});

    // Pass 2: the pilot derives byte-identical content. The old rejection
    // memory would have matched it and recorded `rejected-stable` forever.
    const second = await run();
    expect(
      second.draftOutcomes.some(
        (outcome) => outcome.status === 'rejected-stable',
      ),
    ).toBe(false);
    expect(second.designContract?.status).toBe('applied');
    expect(second.appliedDraftIds).toHaveLength(1);
  });
});
