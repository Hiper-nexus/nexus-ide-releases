import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// electron mock mínimo — downloadPublicAsset só usa fs/fetch.
const electron = vi.hoisted(() => ({
  app: { getPath: () => `/tmp/nexus-updater-dl-${process.pid}` },
  autoUpdater: { on: vi.fn() },
}));
vi.mock('electron', () => electron);

import {
  downloadPublicAsset,
  DOWNLOAD_STALL_MS,
} from './updater';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-dl-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function streamOfChunks(
  chunks: string[],
  stallAfter = false,
  signal?: AbortSignal,
) {
  let sent = 0;
  let source:
    | ReadableStreamDefaultController<Uint8Array>
    | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
    pull(controller) {
      if (sent < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[sent]!));
        sent += 1;
      } else if (!stallAfter) {
        controller.close();
      }
      // stallAfter: nunca fecha nem emite mais — trava de rede.
    },
  });
  if (signal) {
    // fetch real ERRA o body quando o signal aborta — cancel() só fecharia.
    signal.addEventListener('abort', () => {
      source?.error(new DOMException('This operation was aborted', 'AbortError'));
    });
  }
  return stream;
}

function stubFetchStream(
  chunks: string[],
  stallAfter: boolean,
  headers: Record<string, string> = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { signal?: AbortSignal }) =>
      new Response(streamOfChunks(chunks, stallAfter, init?.signal), {
        status: 200,
        headers,
      }),
    ),
  );
}

describe('downloadPublicAsset (progresso + watchdog de stall)', () => {
  it('grava o arquivo e reporta progresso acumulado com total', async () => {
    const onProgress = vi.fn();
    const destination = join(dir, 'ok.zip');
    stubFetchStream(['abc', 'defg'], false, { 'content-length': '7' });

    await downloadPublicAsset(
      'https://example/ok.zip',
      destination,
      60_000,
      onProgress,
    );

    expect(readFileSync(destination, 'utf8')).toBe('abcdefg');
    const calls = onProgress.mock.calls.map((c) => c[0] as { receivedBytes: number });
    expect(calls.at(-1)?.receivedBytes).toBe(7);
    expect(calls.some((c) => c.receivedBytes === 3)).toBe(true);
  });

  it('stall de rede aborta com erro claro em vez de pendurar para sempre (a madrugada do print)', async () => {
    vi.useFakeTimers();
    const destination = join(dir, 'stall.zip');
    stubFetchStream(['parte-1'], true);

    const promise = downloadPublicAsset(
      'https://example/stall.zip',
      destination,
      10 * 60_000,
    );
    // deixa o pipeline consumir o primeiro chunk e armar o watchdog
    await vi.advanceTimersByTimeAsync(10);
    await expect(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS + 1_000);
      await promise;
    }).rejects.toThrow(/sem progresso|travou/i);
  });

  it('deadline total continua valendo (abort geral)', async () => {
    vi.useFakeTimers();
    const destination = join(dir, 'deadline.zip');
    stubFetchStream(['x'], true);

    const promise = downloadPublicAsset(
      'https://example/deadline.zip',
      destination,
      5_000,
    );
    await vi.advanceTimersByTimeAsync(10);
    await expect(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;
    }).rejects.toThrow();
    expect(statSync(destination).size).toBeGreaterThanOrEqual(0);
  });
});
