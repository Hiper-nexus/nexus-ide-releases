import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AsyncGitRunner } from '../runtime/git-command';
import { ProcessGitRunner } from '../runtime/git-command';
import { walkOrientationTreeAsync } from './orientation/orientation-walker';
import { runCandidateQualityAnalysis } from './candidate-quality-scanner';

const temporaryRoots: string[] = [];
const UNREACHABLE_SOURCE = 'export function changed() {\n  return 1;\n  console.log("unreachable");\n}\n';

function realGitFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quality-git-')));
  temporaryRoots.push(root);
  const git = new ProcessGitRunner();
  const run = (...args: string[]) => git.run(root, args).stdout.trim();
  run('init', '-q');
  run('config', 'user.name', 'Nexus Test');
  run('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/candidate.ts'), 'export function changed() {\n  return 1;\n}\n');
  run('add', '--', 'src/candidate.ts');
  run('commit', '-qm', 'Initial fixture');
  const headSha = run('rev-parse', 'HEAD');
  const scope: ProjectExecutionScope = {
    version: 1, installationId: 'install-a', projectId: 'project-a',
    checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest',
  };
  return { root, run, scope, headSha };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quality-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'candidate.ts'),
    [
      'export function changed(): number {',
      '  return 1;',
      '  console.log("unreachable");',
      '}',
    ].join('\n'),
  );
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const git: AsyncGitRunner = {
    run: vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: `${headSha}\n`, stderr: '' };
      }
      return {
        status: 0,
        stdout: [
          'diff --git a/src/candidate.ts b/src/candidate.ts',
          '--- a/src/candidate.ts',
          '+++ b/src/candidate.ts',
          '@@ -1,0 +1,4 @@',
          '+export function changed(): number {',
          '+  return 1;',
          '+  console.log("unreachable");',
          '+}',
        ].join('\n'),
        stderr: '',
      };
    }),
  };
  return { root, scope, baseSha, headSha, git };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('candidate quality scanner', () => {
  it('documentation does not exhaust the source budget before existing implementations', async () => {
    const { root, scope, baseSha, headSha, git } = fixture();
    fs.mkdirSync(path.join(root, 'aaa-docs'));
    for (let i = 0; i < 1600; i++) fs.writeFileSync(path.join(root, 'aaa-docs', `${i}.md`), '# Notes');
    const body = '{ let total = 0; for (const value of values) { if (Number.isFinite(value) && value > 0) { total += value; } } return Math.round(total * 100) / 100; }';
    fs.writeFileSync(path.join(root, 'src', 'existing.ts'), `export function existing(values: number[]) ${body}`);
    fs.writeFileSync(path.join(root, 'src', 'candidate.ts'), `export function changed(values: number[]) ${body}`);
    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha, headSha, diffHash: 'd'.repeat(64), changedFiles: ['src/candidate.ts'],
    }, { git });
    expect(result.findings.some((finding) => /Duplicate implementation/.test(finding.evidence) && finding.evidence.includes('src/existing.ts'))).toBe(true);
    expect(result.inspectedFiles).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('skips a source that exceeds remaining bytes so later small implementations are still compared', async () => {
    const { root, scope, baseSha, headSha, git } = fixture();
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, 'src', `a${i}.ts`), `/*${'p'.repeat(300 * 1024)}*/`);
    const body = '{ let total = 0; for (const value of values) { if (Number.isFinite(value) && value > 0) { total += value; } } return Math.round(total * 100) / 100; }';
    fs.writeFileSync(path.join(root, 'src', 'z-existing.ts'), `export function existing(values: number[]) ${body}`);
    fs.writeFileSync(path.join(root, 'src', 'candidate.ts'), `export function changed(values: number[]) ${body}`);
    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha, headSha, diffHash: 'd'.repeat(64), changedFiles: ['src/candidate.ts'],
    }, { git });
    expect(result.findings.some((finding) => /Duplicate implementation/.test(finding.evidence) && finding.evidence.includes('src/z-existing.ts'))).toBe(true);
    expect(result.inspectedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.complete).toBe(false);
    expect(result.incompleteReasons).toContain('source byte limit 8388608 reached');
  });

  it.each(['dirty', 'staged', 'untracked'] as const)(
    'finds real unreachable code in a %s working-tree candidate without changing Git index',
    async (kind) => {
      const { root, run, scope, headSha } = realGitFixture();
      const file = kind === 'untracked' ? 'src/new.ts' : 'src/candidate.ts';
      fs.writeFileSync(path.join(root, file), UNREACHABLE_SOURCE);
      if (kind === 'staged') run('add', '--', file);
      const beforeIndex = fs.readFileSync(path.join(root, '.git/index'));

      const result = await runCandidateQualityAnalysis({
        scope, checkoutPath: root, baseSha: headSha, headSha,
        diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
      });

      expect(result.complete).toBe(true);
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'high', file, line: 3 }),
      ]));
      expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(beforeIndex);
      expect(run('rev-parse', 'HEAD')).toBe(headSha);
    },
  );

  it('keeps commit mode on the committed diff when the caller did not request a working tree', async () => {
    const { root, scope, headSha } = realGitFixture();
    fs.writeFileSync(path.join(root, 'src/candidate.ts'), UNREACHABLE_SOURCE);
    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha: headSha, headSha,
      diffHash: 'd'.repeat(64), changedFiles: ['src/candidate.ts'],
    });
    expect(result.findings.some((finding) => finding.severity === 'high')).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.candidateFingerprint).toBeUndefined();
  });

  it('handles tracked additions, renames, and deletions without treating deleted source as unreadable', async () => {
    const { root, run, scope, headSha: baseSha } = realGitFixture();
    run('mv', '--', 'src/candidate.ts', 'src/renamed.ts');
    fs.writeFileSync(path.join(root, 'src/renamed.ts'), UNREACHABLE_SOURCE);
    fs.writeFileSync(path.join(root, 'src/new.ts'), UNREACHABLE_SOURCE);
    run('add', '--', 'src/renamed.ts', 'src/new.ts');
    run('commit', '-qm', 'Rename and add candidate');
    const headSha = run('rev-parse', 'HEAD');
    fs.unlinkSync(path.join(root, 'src/new.ts'));

    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha, headSha,
      diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
    });

    expect(result.complete).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'high', file: 'src/renamed.ts', line: 3 }),
    ]));
    expect(result.incompleteReasons).toEqual([]);
  });

  it('analyzes a new directory without requiring Git or inventing a committed candidate', async () => {
    const { root, scope, headSha } = realGitFixture();
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/candidate.ts'), UNREACHABLE_SOURCE);
    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha: headSha, headSha,
      diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
    });
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'high', file: 'src/candidate.ts', line: 3 }),
    ]));
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it.each(['dirty-edit', 'untracked-added', 'head-changed'] as const)(
    'marks a candidate partial when %s occurs while walking its sources',
    async (change) => {
      const { root, run, scope, headSha } = realGitFixture();
      fs.writeFileSync(path.join(root, 'src/candidate.ts'), UNREACHABLE_SOURCE);
      const result = await runCandidateQualityAnalysis({
        scope, checkoutPath: root, baseSha: headSha, headSha,
        diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
      }, {
        walk: async (walkScope, limits, signal) => {
          if (change === 'dirty-edit') fs.appendFileSync(path.join(root, 'src/candidate.ts'), '\nexport const later = 2;\n');
          if (change === 'untracked-added') fs.writeFileSync(path.join(root, 'src/later.ts'), UNREACHABLE_SOURCE);
          if (change === 'head-changed') {
            run('add', '--', 'src/candidate.ts');
            run('commit', '-qm', 'Concurrent change');
          }
          return walkOrientationTreeAsync(walkScope, limits, signal);
        },
      });
      expect(result.complete).toBe(false);
      expect(result.incompleteReasons).toContain('working-tree candidate changed during analysis');
      expect(result.reviewerMarkdown).toContain('partial');
    },
  );

  it('rejects an initial HEAD mismatch instead of claiming the supplied commit was reviewed', async () => {
    const { root, scope, headSha } = realGitFixture();
    await expect(runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha: headSha, headSha: '0'.repeat(40),
      diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
    })).rejects.toThrow('HEAD does not match');
  });

  it('does not claim completeness when changed source exceeds the scanner limit', async () => {
    const { root, scope, headSha } = realGitFixture();
    fs.writeFileSync(path.join(root, 'src/large.ts'), ' '.repeat(384 * 1024 + 1));
    const result = await runCandidateQualityAnalysis({
      scope, checkoutPath: root, baseSha: headSha, headSha,
      diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree',
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReasons.some((reason) => reason.includes('large.ts'))).toBe(true);
  });

  it('binds evidence to current source bytes even when HEAD, filenames, and findings stay equal', async () => {
    const { root, scope, headSha } = realGitFixture();
    const input = { scope, checkoutPath: root, baseSha: headSha, headSha,
      diffHash: 'd'.repeat(64), changedFiles: [], candidateSource: 'working-tree' as const };
    fs.writeFileSync(path.join(root, 'src/new.ts'), 'export const value = 1;\n');
    const first = await runCandidateQualityAnalysis(input);
    fs.writeFileSync(path.join(root, 'src/new.ts'), 'export const value = 2;\n');
    const second = await runCandidateQualityAnalysis(input);
    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(first.analysisHash).not.toBe(second.analysisHash);
    expect(first.candidateFingerprint).not.toBe(second.candidateFingerprint);
  });

  it('binds deterministic findings and evidence hash to the exact candidate diff', async () => {
    const { root, scope, baseSha, headSha, git } = fixture();
    const result = await runCandidateQualityAnalysis(
      {
        scope,
        checkoutPath: root,
        baseSha,
        headSha,
        diffHash: 'd'.repeat(64),
        changedFiles: ['src/candidate.ts'],
      },
      {
        git,
        walk: async () => ({
          files: [
            {
              relativePath: 'src/candidate.ts',
              ext: '.ts',
              language: 'ts',
              size: fs.statSync(path.join(root, 'src', 'candidate.ts')).size,
              isSource: true,
              isSecretName: false,
            },
          ],
          truncated: false,
          treeFingerprintParts: [],
        }),
      },
    );

    expect(result.complete).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'high', line: 3 }),
      ]),
    );
    expect(result.analysisHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.reviewerMarkdown).toContain(result.analysisHash);

    const rebound = await runCandidateQualityAnalysis(
      {
        scope,
        checkoutPath: root,
        baseSha,
        headSha,
        diffHash: 'e'.repeat(64),
        changedFiles: ['src/candidate.ts'],
      },
      {
        git,
        walk: async () => ({
          files: [],
          truncated: true,
          treeFingerprintParts: [],
        }),
      },
    );
    expect(rebound.complete).toBe(false);
    expect(rebound.analysisHash).not.toBe(result.analysisHash);
    expect(rebound.reviewerMarkdown).toMatch(/partial/i);
  });
});
