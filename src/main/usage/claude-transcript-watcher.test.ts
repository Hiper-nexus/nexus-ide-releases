import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectSlug } from './claude-transcript';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import { ClaudeTranscriptResumeStore } from './claude-transcript-resume-store';
import * as resumeState from './codex-rollout-resume-state';

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

afterEach(async () => {
  await Promise.all(liveWatchers.splice(0).map((watcher) => watcher.stop()));
  vi.restoreAllMocks();
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

  it('stop waits for an in-flight checkpoint and persists it before restarting', async () => {
    const project = tempProject();
    const file = path.join(project.projectDir, 'session.jsonl');
    const resumeFile = path.join(project.stateDir, 'resume.json');
    writeTranscript(file, 200, 'x'.repeat(200));
    const readDigests = resumeState.readPrefixDigests;
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    let checkpointStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkpointStarted = resolve; });
    vi.spyOn(resumeState, 'readPrefixDigests').mockImplementationOnce(async (...args) => {
      checkpointStarted();
      await checkpointGate;
      return readDigests(...args);
    });
    const watcher = watcherFor(project, [], new ClaudeTranscriptResumeStore(resumeFile));
    watcher.start();
    await started;
    let stopped = false;
    const stopping = Promise.resolve(watcher.stop()).then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      releaseCheckpoint();
      await stopping;
    }
    expect(new ClaudeTranscriptResumeStore(resumeFile).get(file)?.offset).toBe(fs.statSync(file).size);
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
    await firstWatcher.stop();

    fs.appendFileSync(file, numberedLine('session-boot', 200));
    const second: string[] = [];
    watcherFor(
      project,
      second,
      new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json')),
    ).start();

    await vi.waitFor(() => expect(second).toEqual(['message-200']), { timeout: 5_000, interval: 20 });
  });

  it.each([192, 64, 63])('checkpoints only delivered chunks when stopped on message %s', async (stopAfter) => {
    const project = tempProject();
    const file = path.join(project.projectDir, 'session.jsonl');
    const resumeFile = path.join(project.stateDir, 'resume.json');
    writeTranscript(file, 192, 'x'.repeat(200));
    // Make slice boundaries deterministic; the production clock is unchanged.
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const seen: string[] = [];
    let stopped!: Promise<void> | void;
    let delivered!: () => void;
    const ready = new Promise<void>((resolve) => { delivered = resolve; });
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      resumeStore: new ClaudeTranscriptResumeStore(resumeFile),
      onEvent: (event) => {
        seen.push(event.messageId ?? '');
        if (seen.length === stopAfter) {
          stopped = watcher.stop();
          delivered();
        }
      },
    });
    liveWatchers.push(watcher);
    watcher.start();
    await ready;
    await stopped;
    expect(seen).toHaveLength(stopAfter);
    const saved = new ClaudeTranscriptResumeStore(resumeFile).get(file);
    if (stopAfter === 192) expect(saved?.offset).toBe(fs.statSync(file).size);
    else expect(saved).toBeNull(); // Never skip undelivered lines in this chunk.
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
    await firstWatcher.stop();

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

describe('ClaudeTranscriptWatcher custo por ciclo de varredura', () => {
  const POLL_MS = 15;

  /** Linha > MIN_RESUMABLE_PREFIX_BYTES: o 1º checkpoint já grava digests. */
  function bigLine(sessionId: string, n: number): string {
    return `${JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: new Date(1_700_000_000_000 + n).toISOString(),
      message: {
        id: `message-${sessionId}-${n}`,
        model: 'claude-sonnet-4-5',
        content: 'x'.repeat(13_000),
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })}\n`;
  }

  function setup(fileCount: number, pad = false) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watcher-scan-'));
    tempRoots.push(tempRoot);
    const configDir = path.join(tempRoot, 'claude-config');
    const workspace = path.join(tempRoot, 'checkout');
    const projectDir = path.join(configDir, 'projects', claudeProjectSlug(workspace));
    fs.mkdirSync(projectDir, { recursive: true });
    const files: string[] = [];
    for (let n = 0; n < fileCount; n += 1) {
      const file = path.join(projectDir, `session-${n}.jsonl`);
      fs.writeFileSync(file, pad ? bigLine(`s-${n}`, 0) : transcriptLine(`s-${n}`));
      files.push(file);
    }
    return { tempRoot, configDir, workspace, projectDir, files, stateDir: path.join(tempRoot, 'state') };
  }

  /** Conta os stat(2) de UM arquivo: 1 por ciclo de varredura (arquivo intacto). */
  function statCounterFor(file: string): { count: () => number } {
    const realStat = fs.promises.stat.bind(fs.promises);
    let count = 0;
    vi.spyOn(fs.promises, 'stat').mockImplementation((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === file) count += 1;
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    });
    return { count: () => count };
  }

  function watcherForProject(
    project: ReturnType<typeof setup>,
    options: Partial<ConstructorParameters<typeof ClaudeTranscriptWatcher>[0]> = {},
  ): ClaudeTranscriptWatcher {
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      pollMs: POLL_MS,
      onEvent: vi.fn(),
      ...options,
    });
    liveWatchers.push(watcher);
    return watcher;
  }

  it('resolve projectDirs uma vez por ciclo, não uma vez por arquivo', async () => {
    const project = setup(5);
    const roots = new Set([project.workspace]);
    const workspacePaths = vi.fn(() => roots);
    const marker = statCounterFor(project.files[0]!);
    watcherForProject(project, { workspacePaths }).start();

    await vi.waitFor(() => expect(marker.count()).toBeGreaterThanOrEqual(6), { timeout: 5_000, interval: 5 });
    const cycles = marker.count();
    // Antes: 1 (loop externo) + N+1 (includes por entrada) por ciclo.
    expect(workspacePaths.mock.calls.length).toBeLessThanOrEqual(cycles * 2);
  });

  it('arquivo sem mudança não entra na fila nem reprocessa digests', async () => {
    const project = setup(4, true);
    const store = new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json'));
    const loadSpy = vi.spyOn(store, 'loadAsync');
    const digestSpy = vi.spyOn(resumeState, 'readPrefixDigests');
    const marker = statCounterFor(project.files[0]!);
    watcherForProject(project, { resumeStore: store }).start();

    await vi.waitFor(() => expect(marker.count()).toBeGreaterThanOrEqual(4), { timeout: 5_000, interval: 5 });
    // O 1º contato grava digests (arquivos grandes); daqui em diante nada muda.
    expect(digestSpy.mock.calls.length).toBeGreaterThan(0);
    const loadsAt = loadSpy.mock.calls.length;
    const digestsAt = digestSpy.mock.calls.length;
    const statsAt = marker.count();

    await vi.waitFor(() => expect(marker.count()).toBeGreaterThanOrEqual(statsAt + 3), { timeout: 5_000, interval: 5 });
    // 3 ciclos com 4 arquivos intactos: antes eram ~6 chamadas de loadAsync
    // por ciclo (1 scanAll + 4 enqueues + 1 dentro do saveAsync); depois
    // restam a do scanAll e a interna do saveAsync — 2 por ciclo.
    const cyclesMeasured = marker.count() - statsAt;
    expect(loadSpy.mock.calls.length - loadsAt).toBeLessThanOrEqual(cyclesMeasured * 2 + 2);
    // Arquivo intacto nunca recomputa SHA-256 (já valia; o teste trava).
    expect(digestSpy.mock.calls.length - digestsAt).toBe(0);
  });

  it('arquivo que cresce entre ciclos é lido no ciclo seguinte', async () => {
    const project = setup(1);
    const seen: string[] = [];
    const file = project.files[0]!;
    fs.writeFileSync(file, [0, 1, 2].map((n) => bigLine('grow', n)).join(''));
    watcherForProject(project, { onEvent: (event) => seen.push(event.messageId ?? '') }).start();
    await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 5_000, interval: 5 });

    fs.appendFileSync(file, [3, 4].map((n) => bigLine('grow', n)).join(''));
    await vi.waitFor(() => expect(seen).toHaveLength(5), { timeout: 5_000, interval: 5 });
  });

  it('rotação (encolhimento) reinicia o offset e relê o arquivo novo', async () => {
    const project = setup(1);
    const seen: string[] = [];
    const file = project.files[0]!;
    fs.writeFileSync(file, [0, 1, 2, 3, 4].map((n) => bigLine('old', n)).join(''));
    watcherForProject(project, { onEvent: (event) => seen.push(event.messageId ?? '') }).start();
    await vi.waitFor(() => expect(seen).toHaveLength(5), { timeout: 5_000, interval: 5 });

    // Mesmo nome, conteúdo novo e MENOR: o watcher recomeça do zero.
    fs.writeFileSync(file, [0, 1].map((n) => bigLine('new', n)).join(''));
    await vi.waitFor(() => expect(seen).toHaveLength(7), { timeout: 5_000, interval: 5 });
    expect(seen.slice(5)).toEqual(['message-new-0', 'message-new-1']);
  });

  it('arquivo apagado sai do estado e do resume store, e o ciclo segue', async () => {
    const project = setup(2, true);
    const store = new ClaudeTranscriptResumeStore(path.join(project.stateDir, 'resume.json'));
    const seen: string[] = [];
    const [fileA, fileB] = project.files;
    watcherForProject(project, { resumeStore: store, onEvent: (event) => seen.push(event.messageId ?? '') }).start();
    await vi.waitFor(() => expect(store.get(fileA!)).not.toBeNull(), { timeout: 5_000, interval: 5 });
    await vi.waitFor(() => expect(store.get(fileB!)).not.toBeNull(), { timeout: 5_000, interval: 5 });

    fs.unlinkSync(fileA!);
    await vi.waitFor(() => expect(store.get(fileA!)).toBeNull(), { timeout: 5_000, interval: 5 });

    fs.appendFileSync(fileB!, bigLine('s-1', 9));
    await vi.waitFor(() => expect(seen).toContain('message-s-1-9'), { timeout: 5_000, interval: 5 });
  });

  it('sobe o rescan para 30s quando todos os diretórios têm fs.watch saudável', async () => {
    const project = setup(1);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      onEvent: vi.fn(),
    });
    liveWatchers.push(watcher);
    watcher.start();

    await vi.waitFor(
      () => expect(intervalSpy.mock.calls.some((call) => call[1] === 30_000)).toBe(true),
      { timeout: 5_000, interval: 10 },
    );
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(5_000);
  });

  it('mantém o rescan em 5s quando o fs.watch falha', async () => {
    const project = setup(1);
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch indisponível');
    });
    const marker = statCounterFor(project.files[0]!);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      onEvent: vi.fn(),
    });
    liveWatchers.push(watcher);
    watcher.start();

    await vi.waitFor(() => expect(marker.count()).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(intervalSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(true);
    expect(intervalSpy.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
  });

  it('volta para 5s quando um fs.watch saudável emite erro', async () => {
    const project = setup(1);
    const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void };
    fakeWatcher.close = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue(fakeWatcher as unknown as fs.FSWatcher);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: project.workspace,
      configDirs: [project.configDir],
      onEvent: vi.fn(),
    });
    liveWatchers.push(watcher);
    watcher.start();

    await vi.waitFor(
      () => expect(intervalSpy.mock.calls.some((call) => call[1] === 30_000)).toBe(true),
      { timeout: 5_000, interval: 10 },
    );
    fakeWatcher.emit('error', new Error('watch morreu'));
    await vi.waitFor(
      () => expect(intervalSpy.mock.calls.filter((call) => call[1] === 5_000).length).toBeGreaterThanOrEqual(2),
      { timeout: 5_000, interval: 10 },
    );
  });
});

describe('ClaudeTranscriptWatcher janela de geração por mensagem', () => {
  const T0 = Date.parse('2026-09-27T17:40:54.935Z');

  function line(value: Record<string, unknown>): string {
    return `${JSON.stringify({ sessionId: 's-orq', ...value })}\n`;
  }
  const user = (offsetMs: number) =>
    line({ type: 'user', timestamp: new Date(T0 + offsetMs).toISOString(), message: { role: 'user' } });
  const assistant = (id: string, offsetMs: number, outputTokens: number) =>
    line({
      type: 'assistant',
      timestamp: new Date(T0 + offsetMs).toISOString(),
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: outputTokens } },
    });

  it('marca o início da requisição e não o reinicia nos resultados de tool intercalados', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watcher-timing-'));
    tempRoots.push(tempRoot);
    const configDir = path.join(tempRoot, 'claude-config');
    const workspace = path.join(tempRoot, 'checkout');
    const projectDir = path.join(configDir, 'projects', claudeProjectSlug(workspace));
    fs.mkdirSync(projectDir, { recursive: true });
    // Padrão do transcript real: a mensagem grava linhas, uma tool roda no
    // meio (linha `user` com o resultado) e a MESMA mensagem segue gravando.
    fs.writeFileSync(
      path.join(projectDir, 's-orq.jsonl'),
      [
        user(0),
        assistant('msg-a', 8_196, 1_109),
        assistant('msg-a', 8_199, 1_109),
        user(8_304),
        assistant('msg-a', 10_111, 1_109),
        user(10_199),
        assistant('msg-b', 18_000, 875),
      ].join(''),
    );

    const seen: Array<{ id: string | null; at: number | null; startedAt: number | null }> = [];
    const watcher = new ClaudeTranscriptWatcher({
      workspacePath: workspace,
      configDirs: [configDir],
      pollMs: 10,
      onEvent: (event, _file, timing) =>
        seen.push({ id: event.messageId, at: event.timestamp, startedAt: timing.requestStartedAt }),
    });
    liveWatchers.push(watcher);
    watcher.start();
    await vi.waitFor(() => expect(seen).toHaveLength(4), { timeout: 1_000, interval: 10 });

    expect(seen.map((entry) => [entry.id, entry.startedAt])).toEqual([
      ['msg-a', T0],
      ['msg-a', T0],
      ['msg-a', T0],
      ['msg-b', T0 + 10_199],
    ]);
  });
});
