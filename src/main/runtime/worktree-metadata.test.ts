import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getWorktreeMetadataPath,
  readWorktreeMetadata,
  resolveGitDir,
  writeWorktreeMetadata,
} from './worktree-metadata';

describe('worktree-metadata', () => {
  let tmpDir: string;
  let worktreeDir: string;
  let commonGitDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worktree-meta-test-'));
    worktreeDir = path.join(tmpDir, 'worktree');
    commonGitDir = path.join(tmpDir, 'repo.git', 'worktrees', 'task-1');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(commonGitDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resolves gitdir for linked worktree (.git file pointing to real gitdir)', () => {
    fs.writeFileSync(
      path.join(worktreeDir, '.git'),
      `gitdir: ${commonGitDir}\n`,
      'utf8',
    );

    const resolved = resolveGitDir(worktreeDir);
    expect(resolved).toBe(commonGitDir);
  });

  test('resolves gitdir for normal repo (.git directory)', () => {
    const normalRepo = path.join(tmpDir, 'normal');
    fs.mkdirSync(path.join(normalRepo, '.git'), { recursive: true });

    const resolved = resolveGitDir(normalRepo);
    expect(resolved).toBe(path.join(normalRepo, '.git'));
  });

  test('writes and reads provenance metadata atomically', () => {
    fs.writeFileSync(
      path.join(worktreeDir, '.git'),
      `gitdir: ${commonGitDir}\n`,
      'utf8',
    );

    const written = writeWorktreeMetadata(worktreeDir, {
      baseRefName: 'main',
      branchName: 'task/f-102-test',
      missionId: 'mission-alpha',
      taskId: 'task-1',
      taskTitle: 'Refatorar testes',
      autoArchiveOnMerge: true,
    });

    expect(written.baseRefName).toBe('main');
    expect(written.branchName).toBe('task/f-102-test');
    expect(written.missionId).toBe('mission-alpha');

    const metaPath = getWorktreeMetadataPath(worktreeDir);
    expect(fs.existsSync(metaPath)).toBe(true);

    const read = readWorktreeMetadata(worktreeDir);
    expect(read).toEqual(written);
  });

  test('returns null when metadata file does not exist or is invalid', () => {
    fs.writeFileSync(
      path.join(worktreeDir, '.git'),
      `gitdir: ${commonGitDir}\n`,
      'utf8',
    );

    expect(readWorktreeMetadata(worktreeDir)).toBeNull();

    // Write malformed JSON
    const metaPath = getWorktreeMetadataPath(worktreeDir);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, 'broken json', 'utf8');

    expect(readWorktreeMetadata(worktreeDir)).toBeNull();
  });
});
