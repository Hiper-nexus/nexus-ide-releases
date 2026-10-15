/**
 * Integration: concurrent Git MUTATIONS on one repository must serialize.
 * Now that git-workspace is async, a double click or a poll racing an action
 * used to spawn overlapping `git add`/`git commit` processes — one of them
 * dies on `.git/index.lock: File exists`. Reads (GIT_OPTIONAL_LOCKS=0) stay
 * parallel; only writes queue per real repository root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitCommitMessage,
  gitStage,
  gitUnstage,
} from './git-workspace';

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Nexus Mutation Test',
      GIT_AUTHOR_EMAIL: 'mutation-test@nexus.local',
      GIT_COMMITTER_NAME: 'Nexus Mutation Test',
      GIT_COMMITTER_EMAIL: 'mutation-test@nexus.local',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

describe('git-workspace mutation serialization (real git)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mutation-'));
    run(root, ['init', '-b', 'main']);
    run(root, ['config', 'user.name', 'Nexus Mutation Test']);
    run(root, ['config', 'user.email', 'mutation-test@nexus.local']);
    fs.writeFileSync(path.join(root, 'README.md'), '# mutation\n');
    run(root, ['add', 'README.md']);
    run(root, ['commit', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parallel stages never collide on index.lock', async () => {
    const files = Array.from({ length: 8 }, (_, i) => `file-${i}.ts`);
    for (const [index, file] of files.entries()) {
      fs.writeFileSync(path.join(root, file), `export const v${index} = ${index};\n`);
    }
    const results = await Promise.all(
      files.map((file) => gitStage(root, [file])),
    );
    for (const [index, result] of results.entries()) {
      expect(result, `stage ${files[index]}`).toEqual({ ok: true });
    }
  });

  it('a commit queued after a stage observes the staged file', async () => {
    fs.writeFileSync(path.join(root, 'queued.txt'), 'queued\n');
    const [stage, commit] = await Promise.all([
      gitStage(root, ['queued.txt']),
      gitCommitMessage(root, 'feat: queued'),
    ]);
    expect(stage).toEqual({ ok: true });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    // The commit must include queued.txt: serialization ordered stage → commit.
    const tree = run(root, ['ls-tree', '--name-only', 'HEAD']);
    if (!tree) throw new Error('expected ls-tree output');
    expect(tree.split('\n')).toContain('queued.txt');
  });

  it('mutations on different repositories run in parallel', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mutation-b-'));
    try {
      run(other, ['init', '-b', 'main']);
      run(other, ['config', 'user.name', 'Nexus Mutation Test']);
      run(other, ['config', 'user.email', 'mutation-test@nexus.local']);
      fs.writeFileSync(path.join(other, 'README.md'), '# other\n');
      run(other, ['add', 'README.md']);
      run(other, ['commit', '-m', 'init']);
      fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
      fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
      const [a, b] = await Promise.all([
        gitStage(root, ['a.txt']),
        gitStage(other, ['b.txt']),
      ]);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a failed mutation does not wedge the queue for its repository', async () => {
    const failed = await gitStage(root, ['missing-file.txt']);
    expect(failed.ok).toBe(false);
    fs.writeFileSync(path.join(root, 'after-failure.txt'), 'ok\n');
    const recovered = await gitStage(root, ['after-failure.txt']);
    expect(recovered).toEqual({ ok: true });
    const clean = await gitUnstage(root, ['after-failure.txt']);
    expect(clean).toEqual({ ok: true });
  });
});
