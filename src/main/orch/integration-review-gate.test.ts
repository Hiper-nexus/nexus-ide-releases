import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore, type ScopedMissionStore } from './mission-store';
import { assertIntegrationReviewed } from './integration-review-gate';
import { isFrontierReviewer } from './task-router';

let dir = '';
let repo = '';
let runtime: ProjectRuntimeManager;
let store: ScopedMissionStore;
let missionId = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function headSha(): string {
  return git('rev-parse', 'HEAD');
}

function commitFile(name: string, content: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  git('add', name);
  git('commit', '-qm', `commit ${name}`);
}

function suite() {
  return { missions: store };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-gate-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.name', 'Nexus Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  commitFile('a.txt', 'a');
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(dir, 'runtime'),
    appVersion: 'review-gate-test',
  });
  store = createScopedMissionStore(runtime, testProjectScope({ rootRealPath: repo }));
  missionId = store.create({ title: 'Missão do portão' }).id;
});

afterEach(() => {
  runtime.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function recordVerdict(overrides: Partial<Parameters<typeof store.reviewVerdicts.record>[0]> = {}) {
  return store.reviewVerdicts.record({
    missionId,
    headSha: headSha(),
    treeDirty: false,
    verdict: 'approve',
    reviewerAdapter: 'claude',
    reviewerModel: 'claude-fable-5-1',
    reviewerSession: 'session-judge',
    frontier: true,
    summary: 'Diff revisado e aprovado.',
    ...overrides,
  });
}

describe('isFrontierReviewer', () => {
  it('aceita modelo da mesma linha de um assento da lane de ponta', () => {
    expect(isFrontierReviewer('claude', 'claude-fable-5-1')).toBe(true);
    // claude-opus-5-6 é da linha do opus 5-5 (mais novo da mesma linha).
    expect(isFrontierReviewer('claude', 'claude-opus-5-6')).toBe(true);
    expect(isFrontierReviewer('codex', 'gpt-6.1-sol')).toBe(true);
  });

  it('recusa adapters baratos, linhas antigas e identidade sem modelo', () => {
    expect(isFrontierReviewer('glm', 'glm-5.1')).toBe(false);
    // Linha mais VELHA que o assento não vale (sonnet-5-4 < sonnet-5-5).
    expect(isFrontierReviewer('claude', 'claude-sonnet-5-4')).toBe(false);
    expect(isFrontierReviewer('claude', undefined)).toBe(false);
  });
});

describe('assertIntegrationReviewed', () => {
  it('bloqueia sem veredito para o HEAD atual', () => {
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).toThrow(
      /review_required:.*modelo de ponta.*[a-f0-9]{7}/su,
    );
  });

  it('bloqueia approve de juiz fora da lane de ponta e reject de ponta', () => {
    recordVerdict({ verdict: 'approve', frontier: false, reviewerAdapter: 'glm' });
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).toThrow(/review_required/);
    recordVerdict({ verdict: 'reject', frontier: true });
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).toThrow(/review_required/);
  });

  it('bloqueia árvore suja antes de consultar o veredito', () => {
    recordVerdict();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty');
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).toThrow(
      /review_required: árvore suja/,
    );
  });

  it('passa com approve de ponta do HEAD exato e torna a bloquear quando o HEAD anda', () => {
    recordVerdict();
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).not.toThrow();
    commitFile('b.txt', 'b');
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).toThrow(/review_required/);
    recordVerdict();
    expect(() => assertIntegrationReviewed(suite(), missionId, repo)).not.toThrow();
  });
});

describe('MissionReviewVerdictLedger', () => {
  it('record persiste a linha e latestFor devolve o veredito mais recente do HEAD', () => {
    const older = recordVerdict({ verdict: 'reject', summary: 'reprovado antes' });
    const latest = recordVerdict({ verdict: 'approve', summary: 'aprovado depois' });
    const found = store.reviewVerdicts.latestFor(missionId, headSha());
    expect(found?.verdictId).toBe(latest.verdictId);
    expect(found?.verdictId).not.toBe(older.verdictId);
    expect(found).toMatchObject({
      verdict: 'approve',
      frontier: true,
      reviewerAdapter: 'claude',
      reviewerModel: 'claude-fable-5-1',
    });
  });

  it('latestFor só casa o HEAD exato e a missão exata', () => {
    recordVerdict();
    expect(store.reviewVerdicts.latestFor(missionId, 'b'.repeat(40))).toBeNull();
    expect(store.reviewVerdicts.latestFor('mission-outra', headSha())).toBeNull();
  });

  it('remove os vereditos em cascade com a missão', () => {
    recordVerdict();
    store.remove(missionId);
    expect(store.reviewVerdicts.latestFor(missionId, headSha())).toBeNull();
  });
});
