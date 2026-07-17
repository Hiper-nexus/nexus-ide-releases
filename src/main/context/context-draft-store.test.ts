import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ContextDraftStore } from './context-draft-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-drafts-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  managers.push(value);
  return value;
}

const author = Object.freeze({ id: 'author-a', sessionId: 'session-a', provider: 'codex' });
const reviewer = Object.freeze({ id: 'reviewer-b', sessionId: 'session-b', provider: 'claude' });
const source = Object.freeze({
  type: 'file' as const,
  locator: 'src/billing.ts',
  sourceHash: 'a'.repeat(64),
});

describe('ContextDraftStore', () => {
  it('persists a strict propose-review-apply lifecycle in the physical project scope', () => {
    const runtime = manager();
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ projectId: 'project-b', checkoutId: 'checkout-b' });
    let now = 10;
    const storeA = new ContextDraftStore(runtime, scopeA, {
      now: () => now++,
      idFactory: () => 'draft-a',
    });
    const storeB = new ContextDraftStore(runtime, scopeB);

    const proposed = storeA.propose({
      targetPath: '.context/docs/business-model.md',
      content: '# Business\nUsage billing.\n',
      expectedTargetHash: null,
      sources: [source],
      author,
    });

    expect(proposed).toMatchObject({
      id: 'draft-a',
      status: 'proposed',
      expectedTargetHash: null,
      author,
      reviewer: null,
    });
    expect(proposed.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storeB.get('draft-a')).toBeNull();
    expect(storeA.list({ status: 'proposed' })).toEqual([proposed]);

    const approved = storeA.review('draft-a', {
      decision: 'approve',
      reviewer,
      rationale: 'Claim matches the bound billing source.',
    });
    expect(approved).toMatchObject({ status: 'approved', reviewer });
    expect(approved.reviewedAt).toBeTypeOf('number');

    const applied = storeA.markApplied('draft-a', 'att-'.concat('b'.repeat(40)));
    expect(applied).toMatchObject({
      status: 'applied',
      attestationId: `att-${'b'.repeat(40)}`,
      appliedCommit: null,
    });
    const committed = storeA.markCommitted('draft-a', 'c'.repeat(40));
    expect(committed.appliedCommit).toBe('c'.repeat(40));
  });

  it('enforces one active proposal per target and independent reviewer identity/provider', () => {
    const store = new ContextDraftStore(manager(), testProjectScope(), {
      idFactory: (prefix) => `${prefix}-${Math.random()}`,
    });
    const input = {
      targetPath: '.context/nexus/invariants/core.json',
      content: '{"schemaVersion":1,"facts":[{"id":"scope","statement":"Scoped","claimKey":"scope.required","value":true}]}',
      expectedTargetHash: 'f'.repeat(64),
      sources: [source],
      author,
    };
    const first = store.propose(input);

    expect(() => store.propose(input)).toThrow(/active.*target|unique/i);
    expect(() => store.review(first.id, {
      decision: 'approve',
      reviewer: { ...reviewer, id: author.id },
      rationale: 'No.',
    })).toThrow(/independent/i);
    expect(() => store.review(first.id, {
      decision: 'approve',
      reviewer: { ...reviewer, provider: author.provider },
      rationale: 'No.',
    })).toThrow(/provider/i);

    const rejected = store.review(first.id, {
      decision: 'reject',
      reviewer,
      rationale: 'The invariant overstates the implementation.',
    });
    expect(rejected.status).toBe('rejected');
    expect(() => store.markApplied(first.id, `att-${'d'.repeat(40)}`)).toThrow(/approved/i);
    expect(() => store.review(first.id, {
      decision: 'approve', reviewer, rationale: 'Changed mind.',
    })).toThrow(/proposed/i);

    expect(() => store.propose(input)).not.toThrow();
  });

  it('detects corrupt serialized sources instead of silently trusting them', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const store = new ContextDraftStore(runtime, scope, { idFactory: () => 'draft-corrupt' });
    store.propose({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\n',
      expectedTargetHash: null,
      sources: [source],
      author,
    });
    runtime.open(scope).db.prepare(
      'UPDATE context_drafts SET source_refs_json = ? WHERE id = ?',
    ).run('{bad json', 'draft-corrupt');

    expect(() => store.get('draft-corrupt')).toThrow(/invalid context draft/i);
  });

  it('desemperra o wedge de draft-fantasma: erro traz o ID e supersede libera o target', () => {
    const runtime = manager();
    const scope = testProjectScope({ projectId: 'project-wedge', checkoutId: 'checkout-wedge' });
    let n = 0;
    const store = new ContextDraftStore(runtime, scope, {
      now: () => 100 + n,
      idFactory: () => `draft-wedge-${n++}`,
    });
    const target = '.context/docs/testing.md';
    const blocker = store.propose({
      targetPath: target,
      content: '# Testing v1\n',
      expectedTargetHash: null,
      sources: [source],
      author,
    });
    expect(store.activeForTarget(target)?.id).toBe(blocker.id);

    // Segundo propose no mesmo target: erro agora carrega o ID acionável.
    expect(() =>
      store.propose({
        targetPath: target,
        content: '# Testing v2\n',
        expectedTargetHash: null,
        sources: [source],
        author,
      }),
    ).toThrow(new RegExp(`already exists.*${blocker.id}`, 's'));

    // Escape: supersede libera o target.
    const superseded = store.supersedeActiveForTarget(target);
    expect(superseded?.id).toBe(blocker.id);
    expect(superseded?.status).toBe('rejected');
    expect(store.activeForTarget(target)).toBeNull();

    // Agora uma nova proposta passa.
    const fresh = store.propose({
      targetPath: target,
      content: '# Testing v2\n',
      expectedTargetHash: null,
      sources: [source],
      author,
    });
    expect(fresh.status).toBe('proposed');
    expect(store.activeForTarget(target)?.id).toBe(fresh.id);
  });

  it('supersede num target já livre devolve null (idempotente)', () => {
    const runtime = manager();
    const scope = testProjectScope({ projectId: 'project-free', checkoutId: 'checkout-free' });
    const store = new ContextDraftStore(runtime, scope);
    expect(store.supersedeActiveForTarget('.context/docs/testing.md')).toBeNull();
  });
});
