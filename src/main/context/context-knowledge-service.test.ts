import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET,
  ensureContextScaffold,
  inspectContextReadiness,
} from './context-doctor';
import { inspectContextAttestations } from './context-attestation';
import { ContextKnowledgeService } from './context-knowledge-service';
import { buildProjectSymbolIndex } from './symbol-index';

let baseDir = '';
const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return hash(content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeGit(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  write(root, 'README.md', '# Product source\nBilling, scope, architecture and tests.\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'baseline');
}

function applyCompleteContext(
  root: string,
  service: ContextKnowledgeService,
): string[] {
  const sourceHash = hash(fs.readFileSync(path.join(root, 'README.md')));
  const targets = [
    ['.context/docs/project-overview.md', '# Project\nProject overview.\n'],
    ['.context/docs/business-model.md', '# Business\nUsage billing.\n'],
    ['.context/docs/domain-glossary.md', '# Glossary\nAccount is a customer.\n'],
    ['.context/docs/architecture.md', '# Architecture\nScoped runtime.\n'],
    ['.context/docs/testing.md', '# Testing\nUnit and integration tests.\n'],
    ['.context/nexus/invariants/core.json', JSON.stringify({
      schemaVersion: 1,
      facts: [{
        id: 'scope-required',
        statement: 'Every mutation is project scoped.',
        claimKey: 'project.scope.required',
        value: true,
        kind: 'asserted',
        domains: ['core'],
        relatedSymbols: [],
      }],
    })],
  ] as const;
  const ids: string[] = [];
  for (const [targetPath, content] of targets) {
    const draft = service.propose({
      targetPath,
      content,
      expectedTargetHash: null,
      sources: [{ type: 'file', locator: 'README.md', sourceHash }],
    }, { ...author, sessionId: `author:${targetPath}` });
    service.review(draft.id, {
      decision: 'approve',
      reviewer: { ...reviewer, sessionId: `reviewer:${targetPath}` },
      rationale: 'The target is supported by the bound project source.',
    });
    service.apply(draft.id);
    ids.push(draft.id);
  }
  return ids;
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-knowledge-')));
  roots.push(root);
  const scope = testProjectScope({ rootRealPath: root });
  const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  managers.push(manager);
  ensureContextScaffold(scope);
  let id = 0;
  const service = new ContextKnowledgeService(manager, scope, {
    appVersion: '0.12.0-test',
    now: () => 1_700_000_000_000 + id,
    idFactory: () => `draft-${++id}`,
  });
  return { root, scope, manager, service };
}

const author = Object.freeze({ id: 'author-a', sessionId: 'author-session', provider: 'codex' });
const reviewer = Object.freeze({ id: 'reviewer-b', sessionId: 'reviewer-session', provider: 'claude' });

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-knowledge-runtime-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('ContextKnowledgeService autonomous authority workflow', () => {
  it('writes authority only after source-bound independent approval and replaces old attestations', () => {
    const { root, scope, service } = fixture();
    const sourcePath = 'src/billing-rules.ts';
    const sourceV1 = 'export const billingModel = "per-seat";\n';
    const sourceHash = write(root, sourcePath, sourceV1);
    const targetPath = '.context/docs/business-model.md';
    const firstContent = '# Business model\nBilling is per seat.\n';

    const proposed = service.propose({
      targetPath,
      content: firstContent,
      expectedTargetHash: null,
      sources: [{ type: 'file', locator: sourcePath, sourceHash }],
    }, author);
    expect(proposed.status).toBe('proposed');
    expect(fs.existsSync(path.join(root, targetPath))).toBe(false);

    write(root, sourcePath, 'export const billingModel = "usage";\n');
    expect(() => service.review(proposed.id, {
      decision: 'approve', reviewer, rationale: 'Matches implementation.',
    })).toThrow(/source.*changed/i);
    write(root, sourcePath, sourceV1);

    const approved = service.review(proposed.id, {
      decision: 'approve', reviewer, rationale: 'Matches the bound billing rule.',
    });
    expect(approved.status).toBe('approved');
    const firstApplied = service.apply(proposed.id);
    expect(firstApplied.draft.status).toBe('applied');
    expect(fs.readFileSync(path.join(root, targetPath), 'utf8')).toBe(firstContent);
    expect(inspectContextAttestations(scope)).toMatchObject({
      diagnostics: [],
      attestations: [expect.objectContaining({ targetPath, targetHash: hash(firstContent) })],
    });

    const secondContent = '# Business model\nBilling is per seat with annual contracts.\n';
    const second = service.propose({
      targetPath,
      content: secondContent,
      expectedTargetHash: hash(firstContent),
      sources: [{ type: 'file', locator: sourcePath, sourceHash }],
    }, { ...author, sessionId: 'author-session-2' });
    service.review(second.id, {
      decision: 'approve',
      reviewer: { ...reviewer, sessionId: 'reviewer-session-2' },
      rationale: 'Annual contract detail is present in the same reviewed rule.',
    });
    const secondApplied = service.apply(second.id);
    const inspection = inspectContextAttestations(scope);

    expect(secondApplied.attestation.id).not.toBe(firstApplied.attestation.id);
    expect(inspection.diagnostics).toEqual([]);
    expect(inspection.attestations).toHaveLength(1);
    expect(inspection.attestations[0].targetHash).toBe(hash(secondContent));
    expect(fs.existsSync(path.join(
      root,
      `.context/nexus/attestations/${firstApplied.attestation.id}.json`,
    ))).toBe(false);
  });

  it('rejects stale target preconditions, false source hashes and malformed structured facts', () => {
    const { root, service } = fixture();
    const sourcePath = 'src/scope.ts';
    const sourceContent = 'export const requiresScope = true;\n';
    const sourceHash = write(root, sourcePath, sourceContent);
    const targetPath = '.context/nexus/invariants/core.json';
    write(root, targetPath, '{"schemaVersion":1,"facts":[]}');

    expect(() => service.propose({
      targetPath,
      content: '{bad json',
      expectedTargetHash: hash('{"schemaVersion":1,"facts":[]}'),
      sources: [{ type: 'file', locator: sourcePath, sourceHash }],
    }, author)).toThrow(/structured context/i);
    expect(() => service.propose({
      targetPath,
      content: JSON.stringify({ schemaVersion: 1, facts: [{
        id: 'scope-required', statement: 'Scope required.', claimKey: 'scope.required', value: true,
      }] }),
      expectedTargetHash: '0'.repeat(64),
      sources: [{ type: 'file', locator: sourcePath, sourceHash }],
    }, author)).toThrow(/target.*changed/i);
    expect(() => service.propose({
      targetPath,
      content: JSON.stringify({ schemaVersion: 1, facts: [{
        id: 'scope-required', statement: 'Scope required.', claimKey: 'scope.required', value: true,
      }] }),
      expectedTargetHash: hash('{"schemaVersion":1,"facts":[]}'),
      sources: [{ type: 'file', locator: sourcePath, sourceHash: 'f'.repeat(64) }],
    }, author)).toThrow(/source.*hash/i);
  });

  it('blocks author identity aliases while allowing an independent same-provider session', () => {
    const { root, service } = fixture();
    const sourceHash = write(root, 'README.md', '# Source\n');
    const draft = service.propose({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\nRun unit tests.\n',
      expectedTargetHash: null,
      sources: [{ type: 'file', locator: 'README.md', sourceHash }],
    }, author);

    expect(() => service.review(draft.id, {
      decision: 'approve',
      reviewer: { id: author.id, sessionId: 'other-session', provider: 'claude' },
      rationale: 'Self review.',
    })).toThrow(/independent/i);
    const approved = service.review(draft.id, {
      decision: 'approve',
      reviewer: { id: 'other-agent', sessionId: 'other-session', provider: author.provider },
      rationale: 'Independent Codex reviewer session verified all bound sources.',
    });
    expect(approved).toMatchObject({
      status: 'approved',
      reviewer: {
        id: 'other-agent',
        sessionId: 'other-session',
        provider: author.provider,
      },
    });
  });

  it('satisfies readiness with the human operator as the independent reviewer', () => {
    const { root, scope, service } = fixture();
    write(root, 'README.md', '# Product source\nBilling, scope, architecture and tests.\n');
    const sourceHash = hash(fs.readFileSync(path.join(root, 'README.md')));
    // The same identity the context-draft IPC approves with: the human user
    // is independent of the agent author (different id/session/provider).
    const human = Object.freeze({
      id: 'user:local-operator',
      sessionId: 'human-ui-context-review',
      provider: 'human',
    });
    const targets = [
      ['.context/docs/project-overview.md', '# Project\nProject overview.\n'],
      ['.context/docs/business-model.md', '# Business\nUsage billing.\n'],
      ['.context/docs/domain-glossary.md', '# Glossary\nAccount is a customer.\n'],
      ['.context/docs/architecture.md', '# Architecture\nScoped runtime.\n'],
      ['.context/docs/testing.md', '# Testing\nUnit and integration tests.\n'],
      ['.context/nexus/invariants/core.json', JSON.stringify({
        schemaVersion: 1,
        facts: [{
          id: 'scope-required',
          statement: 'Every mutation is project scoped.',
          claimKey: 'project.scope.required',
          value: true,
          kind: 'asserted',
          domains: ['core'],
          relatedSymbols: [],
        }],
      })],
    ] as const;

    for (const [targetPath, content] of targets) {
      const draft = service.propose({
        targetPath,
        content,
        expectedTargetHash: null,
        sources: [{ type: 'file', locator: 'README.md', sourceHash }],
      }, author);
      service.review(draft.id, {
        decision: 'approve',
        reviewer: human,
        rationale: 'Reviewed and approved by the human operator in the Nexus UI.',
      });
      const applied = service.apply(draft.id);
      expect(applied.attestation.reviewer.provider).toBe('human');
    }

    const inspection = inspectContextAttestations(scope);
    expect(inspection.diagnostics).toEqual([]);
    expect(inspection.attestations).toHaveLength(targets.length);
    expect(
      inspection.attestations.every((item) => item.reviewer.provider === 'human'),
    ).toBe(true);

    const readiness = inspectContextReadiness(scope, {
      knownSymbols: buildProjectSymbolIndex(scope).symbols,
    });
    expect(readiness.blockers).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it('commits only the complete reviewed context set and records the portable commit', () => {
    const { root, service } = fixture();
    initializeGit(root);
    const draftIds = applyCompleteContext(root, service);

    const committed = service.commitApplied();
    const head = git(root, 'rev-parse', 'HEAD');

    expect(committed).toMatchObject({ commitSha: head, recovered: false });
    expect(committed.drafts.map((draft) => draft.id).sort()).toEqual([...draftIds].sort());
    expect(committed.drafts.every((draft) => draft.appliedCommit === head)).toBe(true);
    expect(git(root, 'status', '--porcelain=v1', '--', '.context')).toBe('');
    expect(git(root, 'show', '--format=', '--name-only', 'HEAD')).toContain(
      '.context/docs/business-model.md',
    );
    expect(git(root, 'show', '--format=', '--name-only', 'HEAD')).toContain(
      BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET,
    );
  });

  it('supersedes an older uncommitted draft when newer reviewed authority replaces it', () => {
    const { root, service } = fixture();
    initializeGit(root);
    const draftIds = applyCompleteContext(root, service);
    const first = service.get(draftIds.find((id) =>
      service.get(id)?.targetPath === '.context/docs/testing.md',
    ) as string)!;
    const sourceHash = hash(fs.readFileSync(path.join(root, 'README.md')));
    const replacementContent = '# Testing\nRun unit, integration and smoke tests.\n';
    const replacement = service.propose({
      targetPath: first.targetPath,
      content: replacementContent,
      expectedTargetHash: first.contentHash,
      sources: [{ type: 'file', locator: 'README.md', sourceHash }],
    }, { ...author, sessionId: 'replacement-author' });
    service.review(replacement.id, {
      decision: 'approve',
      reviewer: { ...reviewer, sessionId: 'replacement-reviewer' },
      rationale: 'The replacement remains bound to the committed project source.',
    });

    service.apply(replacement.id);

    expect(service.get(first.id)).toMatchObject({
      status: 'superseded',
      attestationId: null,
      appliedCommit: null,
    });
    expect(service.commitApplied()).toMatchObject({ recovered: false });
    expect(fs.readFileSync(path.join(root, first.targetPath), 'utf8'))
      .toBe(replacementContent);
  });

  it('repairs legacy duplicate applied rows before committing the current attestation', () => {
    const { root, scope, manager, service } = fixture();
    initializeGit(root);
    const draftIds = applyCompleteContext(root, service);
    const first = service.get(draftIds.find((id) =>
      service.get(id)?.targetPath === '.context/docs/testing.md',
    ) as string)!;
    const oldAttestationId = first.attestationId as string;
    const sourceHash = hash(fs.readFileSync(path.join(root, 'README.md')));
    const replacement = service.propose({
      targetPath: first.targetPath,
      content: '# Testing\nCurrent reviewed test authority.\n',
      expectedTargetHash: first.contentHash,
      sources: [{ type: 'file', locator: 'README.md', sourceHash }],
    }, { ...author, sessionId: 'legacy-repair-author' });
    service.review(replacement.id, {
      decision: 'approve',
      reviewer: { ...reviewer, sessionId: 'legacy-repair-reviewer' },
      rationale: 'Current authority is independently source-bound.',
    });
    service.apply(replacement.id);

    // Reproduce the v0.15.0 runtime state: the older applied row survived even
    // though its sidecar was replaced by the newer valid attestation.
    manager.open(scope).db.prepare(
      `UPDATE context_drafts
       SET status = 'applied', attestation_id = ?, updated_at = updated_at + 1
       WHERE id = ?`,
    ).run(oldAttestationId, first.id);

    expect(service.commitApplied()).toMatchObject({ recovered: false });
    expect(service.get(first.id)?.status).toBe('superseded');
    expect(service.get(replacement.id)?.appliedCommit).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it('refuses context commit when extra files or pre-staged code could be smuggled in', () => {
    const { root, service } = fixture();
    initializeGit(root);
    applyCompleteContext(root, service);
    write(root, '.context/plans/unreviewed.md', '# Unreviewed plan\n');

    expect(() => service.commitApplied()).toThrow(/unexpected context change/i);
    fs.rmSync(path.join(root, '.context/plans/unreviewed.md'));
    write(root, 'src/prestaged.ts', 'export const hidden = true;\n');
    git(root, 'add', 'src/prestaged.ts');

    expect(() => service.commitApplied()).toThrow(/staged/i);
    expect(git(root, 'log', '-1', '--pretty=%s')).toBe('baseline');
  });

  it('allows only the exact bundled design-system sensor in the finite context commit', () => {
    const { root, service } = fixture();
    initializeGit(root);
    applyCompleteContext(root, service);
    fs.appendFileSync(
      path.join(root, BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET),
      '\n// unreviewed mutation\n',
    );

    expect(() => service.commitApplied()).toThrow(
      new RegExp(`unexpected context change.*${BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET.replaceAll('.', '\\.')}`, 'i'),
    );
    expect(git(root, 'log', '-1', '--pretty=%s')).toBe('baseline');
  });
});
