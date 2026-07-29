import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AsyncGitRunner } from '../runtime/git-command';
import { runCandidateQualityAnalysis } from './candidate-quality-scanner';

const temporaryRoots: string[] = [];

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
