import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkReviewCycleLimit,
  enforceScopeRules,
  filterAntiSocialChatter,
  writeSwarmMailboxMessage,
  MAX_OWNED_FILES_PER_WORKER,
  MAX_REVIEW_CYCLES,
} from './swarm-protocol';

describe('swarm-protocol', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-swarm-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('filterAntiSocialChatter', () => {
    it('strips pleasantries and conversational filler while retaining technical content', () => {
      const input = [
        'Thanks a lot!',
        'Here is the requested patch:',
        '```ts',
        'export const x = 1;',
        '```',
        'Great job!',
      ].join('\n');

      const { clean, strippedCount } = filterAntiSocialChatter(input);
      expect(strippedCount).toBe(2);
      expect(clean).toContain('Here is the requested patch:');
      expect(clean).toContain('export const x = 1;');
      expect(clean).not.toContain('Thanks a lot!');
      expect(clean).not.toContain('Great job!');
    });
  });

  describe('enforceScopeRules', () => {
    it('approves edits strictly within owned files', () => {
      const res = enforceScopeRules({
        ownedFiles: ['src/main/foo.ts', 'src/main/bar.ts'],
        modifiedFiles: ['src/main/foo.ts'],
      });
      expect(res.allowed).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('rejects edits outside declared scope', () => {
      const res = enforceScopeRules({
        ownedFiles: ['src/main/foo.ts'],
        modifiedFiles: ['src/main/foo.ts', 'src/main/unauthorized.ts'],
      });
      expect(res.allowed).toBe(false);
      expect(res.violations).toContain('src/main/unauthorized.ts');
    });

    it('rejects when modified files exceed max bound', () => {
      const files = Array.from(
        { length: MAX_OWNED_FILES_PER_WORKER + 5 },
        (_, i) => `src/file_${i}.ts`,
      );
      const res = enforceScopeRules({
        ownedFiles: files,
        modifiedFiles: files,
      });
      expect(res.allowed).toBe(false);
      expect(res.totalModified).toBe(MAX_OWNED_FILES_PER_WORKER + 5);
    });
  });

  describe('checkReviewCycleLimit', () => {
    it('allows progression under review cycle limit', () => {
      const res = checkReviewCycleLimit(1);
      expect(res.canProceed).toBe(true);
      expect(res.escalateToOperator).toBe(false);
    });

    it('escalates to operator when review cycles reach limit', () => {
      const res = checkReviewCycleLimit(MAX_REVIEW_CYCLES);
      expect(res.canProceed).toBe(false);
      expect(res.escalateToOperator).toBe(true);
    });
  });

  describe('writeSwarmMailboxMessage', () => {
    it('writes transcript-first then recipient inbox with optional nudge', () => {
      const res = writeSwarmMailboxMessage({
        baseDir: tempDir,
        message: {
          sender: 'worker-coder-1',
          recipient: 'worker-reviewer-1',
          content: 'Implemented T7 swarm protocols',
          payload: { status: 'review_requested' },
        },
        nudgeRecipient: true,
      });

      expect(fs.existsSync(res.transcriptPath)).toBe(true);
      expect(fs.existsSync(res.inboxPath)).toBe(true);
      expect(res.nudgePath).toBeDefined();
      expect(fs.existsSync(res.nudgePath!)).toBe(true);

      const transcriptContent = JSON.parse(
        fs.readFileSync(res.transcriptPath, 'utf8'),
      );
      expect(transcriptContent.sender).toBe('worker-coder-1');
      expect(transcriptContent.recipient).toBe('worker-reviewer-1');
      expect(transcriptContent.content).toBe('Implemented T7 swarm protocols');

      const inboxContent = JSON.parse(fs.readFileSync(res.inboxPath, 'utf8'));
      expect(inboxContent.sender).toBe('worker-coder-1');
    });
  });
});
