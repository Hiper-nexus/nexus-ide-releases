import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectSlug } from './claude-transcript';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';

const tempRoots: string[] = [];
const liveWatchers: ClaudeTranscriptWatcher[] = [];

function transcriptLine(sessionId: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: new Date().toISOString(),
    message: {
      id: `message-${sessionId}`,
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
      },
    },
  })}\n`;
}

afterEach(() => {
  for (const watcher of liveWatchers.splice(0)) watcher.stop();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ClaudeTranscriptWatcher execution roots', () => {
  it('derives transcript directories only for the current authorized roots', () => {
    const configDir = '/config/claude-a';
    const coordinationRoot = '/workspace/project-a';
    const worktreeRoot = '/isolated/project-a/task-1';
    const siblingCheckout = '/workspace/project-b';
    const executionRoots = new Set([coordinationRoot]);
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: coordinationRoot,
      workspacePaths: () => executionRoots,
      configDirs: [configDir],
      onEvent: vi.fn(),
    });

    expect(watcher.projectDirs()).toEqual([
      path.join(
        configDir,
        'projects',
        claudeProjectSlug(coordinationRoot),
      ),
    ]);

    executionRoots.add(worktreeRoot);

    expect(watcher.projectDirs()).toEqual([
      path.join(
        configDir,
        'projects',
        claudeProjectSlug(coordinationRoot),
      ),
      path.join(configDir, 'projects', claudeProjectSlug(worktreeRoot)),
    ]);
    expect(watcher.projectDirs()).not.toContain(
      path.join(
        configDir,
        'projects',
        claudeProjectSlug(siblingCheckout),
      ),
    );
  });

  it('discovers a worktree granted after the watcher has started', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'claude-watcher-roots-'),
    );
    tempRoots.push(tempRoot);
    const configDir = path.join(tempRoot, 'claude-config');
    const coordinationRoot = path.join(tempRoot, 'checkout');
    const worktreeRoot = path.join(tempRoot, 'worktrees', 'task-1');
    const executionRoots = new Set([coordinationRoot]);
    const coordinationProjectDir = path.join(
      configDir,
      'projects',
      claudeProjectSlug(coordinationRoot),
    );
    const worktreeProjectDir = path.join(
      configDir,
      'projects',
      claudeProjectSlug(worktreeRoot),
    );
    fs.mkdirSync(coordinationProjectDir, { recursive: true });
    fs.mkdirSync(worktreeProjectDir, { recursive: true });

    const seen: string[] = [];
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: coordinationRoot,
      workspacePaths: () => executionRoots,
      configDirs: [configDir],
      pollMs: 10,
      onEvent: (event) => seen.push(event.sessionId),
    });
    liveWatchers.push(watcher);
    watcher.start();

    fs.writeFileSync(
      path.join(coordinationProjectDir, 'coordination.jsonl'),
      transcriptLine('coordination-session'),
    );
    await vi.waitFor(
      () => expect(seen).toContain('coordination-session'),
      { timeout: 1_000, interval: 10 },
    );

    executionRoots.add(worktreeRoot);
    fs.writeFileSync(
      path.join(worktreeProjectDir, 'worktree.jsonl'),
      transcriptLine('worktree-session'),
    );
    await vi.waitFor(
      () => expect(seen).toContain('worktree-session'),
      { timeout: 1_000, interval: 10 },
    );
  });
});
