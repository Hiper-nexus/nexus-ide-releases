import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectSlug } from './claude-transcript';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import { ClaudeTranscriptResumeStore } from './claude-transcript-resume-store';

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

describe('ClaudeTranscriptWatcher boot cost', () => {
  function tempProject(): { configDir: string; workspace: string; projectDir: string; stateDir: string } {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watcher-boot-'));
    tempRoots.push(tempRoot);
    const configDir = path.join(tempRoot, 'claude-config');
    const workspace = path.join(tempRoot, 'checkout');
    const projectDir = path.join(configDir, 'projects', claudeProjectSlug(workspace));
    fs.mkdirSync(projectDir, { recursive: true });
    return { configDir, workspace, projectDir, stateDir: path.join(tempRoot, 'state') };
  }

  function numberedLine(sessionId: string, n: number, pad = ''): string {
    return `${JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: new Date(1_700_000_000_000 + n).toISOString(),
      message: {
        id: `message-${n}`,
        model: 'claude-sonnet-4-5',
        content: pad,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })}\n`;
  }

  function writeTranscript(file: string, lines: number, pad = ''): void {
    let text = '';
    for (let n = 0; n < lines; n += 1) text += numberedLine('session-boot', n, pad);
    fs.writeFileSync(file, text);
  }

  function watcherFor(
    project: ReturnType<typeof tempProject>,
    seen: string[],
    resumeStore?: ClaudeTranscriptResumeStore,
  ): ClaudeTranscriptWatcher {
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      pollMs: 60_000,
      onEvent: (event) => seen.push(event.messageId ?? ''),
      ...(resumeStore ? { resumeStore } : {}),
    });
    liveWatchers.push(watcher);
    return watcher;
  }

  it('reads a large transcript in bounded slices, one file at a time', async () => {
    const project = tempProject();
    // ~1.3 MB per file with a multi-byte character straddling slice borders.
    writeTranscript(path.join(project.projectDir, 'a.jsonl'), 900, 'é'.repeat(700));
    writeTranscript(path.join(project.projectDir, 'b.jsonl'), 900, 'é'.repeat(700));
    const realOpen = fs.promises.open.bind(fs.promises);
    const readLengths: number[] = [];
    let openNow = 0;
    let openMax = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      openNow += 1;
      openMax = Math.max(openMax, openNow);
      const realRead = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<unknown>;
      const realClose = handle.close.bind(handle);
      Object.assign(handle, {
        read: (...readArgs: unknown[]) => {
          if (typeof readArgs[2] === 'number') readLengths.push(readArgs[2]);
          return realRead(...readArgs);
        },
        close: () => {
          openNow -= 1;
          return realClose();
        },
      });
      return handle;
    });
    const seen: string[] = [];
    watcherFor(project, seen).start();

    await vi.waitFor(() => expect(seen).toHaveLength(1_800), { timeout: 10_000, interval: 20 });
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(512 * 1024);
    expect(openMax).toBe(1);
    vi.restoreAllMocks();
  });

  it('resumes after a restart without replaying what it already read', async () => {
    const project = tempProject();
    const file = path.join(project.projectDir, 'session.jsonl');
    writeTranscript(file, 200, 'x'.repeat(200));
    const first: string[] = [];
    const firstWatcher = watcherFor(
      project,
      first,
      new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json')),
    );
    firstWatcher.start();
    await vi.waitFor(() => expect(first).toHaveLength(200), { timeout: 5_000, interval: 20 });
    firstWatcher.stop();

    fs.appendFileSync(file, numberedLine('session-boot', 200));
    const second: string[] = [];
    watcherFor(
      project,
      second,
      new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json')),
    ).start();

    await vi.waitFor(() => expect(second).toEqual(['message-200']), { timeout: 5_000, interval: 20 });
  });

  it('replays from the start when the transcript was rewritten', async () => {
    const project = tempProject();
    const file = path.join(project.projectDir, 'session.jsonl');
    writeTranscript(file, 200, 'x'.repeat(200));
    const first: string[] = [];
    const firstWatcher = watcherFor(
      project,
      first,
      new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json')),
    );
    firstWatcher.start();
    await vi.waitFor(() => expect(first).toHaveLength(200), { timeout: 5_000, interval: 20 });
    firstWatcher.stop();

    writeTranscript(file, 210, 'y'.repeat(200));
    const second: string[] = [];
    watcherFor(
      project,
      second,
      new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json')),
    ).start();

    await vi.waitFor(() => expect(second).toHaveLength(210), { timeout: 5_000, interval: 20 });
  });
});
