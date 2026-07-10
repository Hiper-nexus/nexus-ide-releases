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
    );
    scanner.stop();
  });
});
