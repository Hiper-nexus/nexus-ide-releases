import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexUsageScanner } from './codex-scanner';

const roots: string[] = [];

function dayDirectory(root: string): string {
  const date = new Date();
  const directory = path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('CodexUsageScanner multi-project activation', () => {
  it('stop returns physical scan and resume settlement', async () => {
    const scanner = new CodexUsageScanner({ isWatched: () => false, onEvent: () => undefined });
    const stopped = scanner.stop();
    expect(stopped).toBeInstanceOf(Promise);
    await stopped;
  });
  it('parks an unrelated rollout then replays it when that project becomes active', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-'));
    roots.push(sessionsDir);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-'));
    roots.push(workspace);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-a', cwd: workspace },
        }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-10T10:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 5,
                output_tokens: 3,
              },
            },
          },
        }),
        '',
      ].join('\n'),
    );
    let active = false;
    const onEvent = vi.fn();
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (file) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return realStat(file);
    });
    const scanner = new CodexUsageScanner({
      sessionsDir,
      pollMs: 1,
      isWatched: (cwd) => active && cwd === workspace,
      onEvent,
    });
    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onEvent).not.toHaveBeenCalled();

    active = true;
    await eventually(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        inputTokens: 15,
        cacheReadTokens: 5,
        outputTokens: 3,
      }),
      workspace,
      {
        providerSessionId: 'session-a',
        threadId: 'session-a',
        rolloutSessionId: null,
        sessionStartedAt: null,
      },
    );
    await scanner.stop();
  });

  it('cede ao event loop durante um replay grande sem perder nem duplicar eventos', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-yield-'));
    roots.push(sessionsDir);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-yield-'));
    roots.push(workspace);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-large.jsonl');
    const usageLines = Array.from({ length: 160 }, (_, index) =>
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.UTC(2026, 6, 29, 12, 0, 0, index)).toISOString(),
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: index + 10,
              cached_input_tokens: 1,
              output_tokens: 1,
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-large', cwd: workspace },
        }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
        ...usageLines,
        '',
      ].join('\n'),
    );

    const messageIds: string[] = [];
    let eventsSeenWhenTimerRan: number | null = null;
    const scanner = new CodexUsageScanner({
      sessionsDir,
      pollMs: 60_000,
      isWatched: (cwd) => cwd === workspace,
      onEvent: (event) => {
        messageIds.push(event.messageId ?? '');
        if (messageIds.length === 1) {
          setTimeout(() => {
            eventsSeenWhenTimerRan = messageIds.length;
          }, 0);
        }
      },
    });

    scanner.start();
    await eventually(() => expect(messageIds).toHaveLength(usageLines.length));
    await eventually(() => expect(eventsSeenWhenTimerRan).not.toBeNull());
    expect(eventsSeenWhenTimerRan).toBeLessThan(usageLines.length);
    expect(new Set(messageIds)).toHaveLength(usageLines.length);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messageIds).toHaveLength(usageLines.length);
    await scanner.stop();
  });

  it('preserva UTF-8 quando um caractere cruza a fronteira de leitura', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-utf8-'));
    roots.push(sessionsDir);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-é-'));
    roots.push(workspace);
    const chunkBytes = 512 * 1024;
    const payload = {
      type: 'session_meta',
      payload: { id: 'session-utf8', padding: '', cwd: workspace },
    };
    const serialized = () => JSON.stringify(payload);
    const markerOffset = () => Buffer.from(serialized()).indexOf(Buffer.from('é'));
    payload.payload.padding = 'x'.repeat(chunkBytes - 1 - markerOffset());
    expect(markerOffset()).toBe(chunkBytes - 1);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-utf8.jsonl');
    fs.writeFileSync(
      rollout,
      [
        serialized(),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T12:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 1,
              },
            },
          },
        }),
        '',
      ].join('\n'),
    );

    const onEvent = vi.fn();
    const scanner = new CodexUsageScanner({
      sessionsDir,
      pollMs: 60_000,
      isWatched: (cwd) => cwd === workspace,
      onEvent,
    });

    scanner.start();
    await eventually(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-utf8' }),
      workspace,
      {
        providerSessionId: 'session-utf8',
        threadId: 'session-utf8',
        rolloutSessionId: null,
        sessionStartedAt: null,
      },
    );
    await scanner.stop();
  });

  it('separa thread e provider session sem emitir o histórico copiado do pai', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-fork-'));
    roots.push(sessionsDir);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-fork-'));
    roots.push(workspace);
    const parentThreadId = '019fab5d-b0bc-7fc1-ac78-510e35abbc48';
    const childThreadId = '019fad78-bf8f-7b63-837f-750b9c02bcd3';
    const rollout = path.join(
      dayDirectory(sessionsDir),
      `rollout-2026-07-29T12-00-00-${childThreadId}.jsonl`,
    );
    const usageLine = (timestamp: string) =>
      JSON.stringify({
        type: 'event_msg',
        timestamp,
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 1,
            },
          },
        },
      });
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: childThreadId,
            session_id: parentThreadId,
            parent_thread_id: parentThreadId,
            timestamp: '2026-07-29T10:43:19.590Z',
            cwd: workspace,
          },
        }),
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: parentThreadId,
            session_id: parentThreadId,
            timestamp: '2026-07-29T10:00:00.000Z',
            cwd: workspace,
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T10:43:19.987Z',
          payload: {
            type: 'task_started',
            turn_id: '019fab5e-ee23-77e0-a9a8-3434e9581ec0',
            started_at: 1_785_286_553,
          },
        }),
        // Codex restamps the copied parent history at child-spawn time, so a
        // timestamp-only filter would incorrectly count this enormous event.
        usageLine('2026-07-29T10:43:19.988Z'),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T10:43:20.262Z',
          payload: {
            type: 'task_started',
            turn_id: '019fad78-c243-7c10-957a-9b08377e4fed',
            started_at: 1_785_321_800,
          },
        }),
        usageLine('2026-07-29T10:43:20.300Z'),
        '',
      ].join('\n'),
    );

    const onEvent = vi.fn();
    const scanner = new CodexUsageScanner({
      sessionsDir,
      pollMs: 60_000,
      isWatched: (cwd) => cwd === workspace,
      onEvent,
    });

    scanner.start();
    await eventually(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: parentThreadId,
        messageId: expect.stringMatching(
          /^codex:v2:[a-f0-9]{64}:2:2026-07-29T10:43:20\.300Z$/,
        ),
      }),
      workspace,
      {
        providerSessionId: parentThreadId,
        threadId: childThreadId,
        rolloutSessionId: childThreadId,
        sessionStartedAt: Date.parse('2026-07-29T10:43:19.590Z'),
        parentThreadId,
      },
    );
    await scanner.stop();
  });

  it('varre também as raízes provider-state por checkout (F-211)', async () => {
    // Desde F-566 os panes Codex do Nexus gravam rollouts em
    // <userData>/provider-state/codex/<checkoutId>/sessions — fora do
    // ~/.codex/sessions nativo. Raízes extras chegam por thunk porque o
    // conjunto de checkouts observados cresce sem reiniciar o scanner.
    const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-native-'));
    const providerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-state-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-state-'));
    roots.push(nativeDir, providerRoot, workspace);
    const rollout = path.join(dayDirectory(providerRoot), 'rollout-state.jsonl');
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-state', cwd: workspace },
        }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-09-28T19:58:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 12,
                cached_input_tokens: 4,
                output_tokens: 2,
              },
            },
          },
        }),
        '',
      ].join('\n'),
    );

    const onEvent = vi.fn();
    const scanner = new CodexUsageScanner({
      sessionsDir: nativeDir,
      sessionsDirs: () => [providerRoot],
      pollMs: 1,
      isWatched: (cwd) => cwd === workspace,
      onEvent,
    });
    scanner.start();
    await eventually(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-state',
        inputTokens: 8,
        outputTokens: 2,
      }),
      workspace,
      {
        providerSessionId: 'session-state',
        threadId: 'session-state',
        rolloutSessionId: null,
        sessionStartedAt: null,
      },
    );
    await scanner.stop();
  });

  it('raízes extras avaliadas a cada varredura acompanham checkouts novos', async () => {
    // Um checkout que começa a ser observado DEPOIS do scanner subir entra na
    // varredura seguinte sem recriar o objeto.
    const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-late-native-'));
    const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-late-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-late-'));
    roots.push(nativeDir, lateRoot, workspace);
    const extraRoots: string[] = [];
    const onEvent = vi.fn();
    const scanner = new CodexUsageScanner({
      sessionsDir: nativeDir,
      sessionsDirs: () => extraRoots,
      pollMs: 1,
      isWatched: (cwd) => cwd === workspace,
      onEvent,
    });
    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEvent).not.toHaveBeenCalled();

    const rollout = path.join(dayDirectory(lateRoot), 'rollout-late.jsonl');
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-late', cwd: workspace },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-09-28T20:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          },
        }),
        '',
      ].join('\n'),
    );
    extraRoots.push(lateRoot);
    await eventually(() => expect(onEvent).toHaveBeenCalledTimes(1));
    await scanner.stop();
  });
});
