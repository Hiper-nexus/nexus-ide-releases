import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { spawn } from 'node:child_process';
import { callMcpToolOnce, mcpResultText } from './ui-kit-mcp-call';
import { UiKitCliError } from './ui-kit-cli';

type Responder = (
  message: Record<string, unknown>,
  emit: (line: unknown) => void,
  close: () => void,
) => void;

interface FakeServer {
  readonly child: ReturnType<typeof spawn>;
  readonly writes: string[];
  /** The stdin stream, so a test can break it the way a real pipe breaks. */
  readonly stdin: EventEmitter;
}

/**
 * A fake stdio MCP server. `pid` is left undefined on purpose: the real
 * teardown path signals a process group, which a test must never do.
 */
function fakeServer(respond: Responder): FakeServer {
  const writes: string[] = [];
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn> & {
    stdin: EventEmitter & {
      write: (chunk: string, callback?: (error?: Error | null) => void) => void;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  // An EventEmitter, like the real `child.stdin`: `write()` reports EPIPE
  // asynchronously on the stream, and a plain object with a `write` method
  // cannot express that at all.
  const stdin = new EventEmitter() as EventEmitter & {
    write: (chunk: string, callback?: (error?: Error | null) => void) => void;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emit = (line: unknown): void => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`, 'utf8'));
  };
  const close = (): void => {
    child.emit('close', 0);
  };
  stdin.write = (chunk: string, callback?: (error?: Error | null) => void) => {
    writes.push(chunk);
    callback?.(null);
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      respond(JSON.parse(trimmed) as Record<string, unknown>, emit, close);
    }
  };
  Object.assign(child, { stdin, stdout, stderr, pid: undefined });
  return { child, writes, stdin };
}

/**
 * A real directory: the cwd guard stats it for real, which is the point — the
 * MCP door and the CLI door go through the same check.
 */
let projectDir = '';

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-mcp-'));
});

afterAll(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function base() {
  return { kit: 'boardui', cwd: projectDir } as const;
}

function handshake(respond: Responder): Responder {
  return (message, emit, close) => {
    if (message.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
      return;
    }
    respond(message, emit, close);
  };
}

describe('callMcpToolOnce', () => {
  it('initializes, calls the tool and returns its text', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/call') {
          emit({
            jsonrpc: '2.0',
            id: 2,
            result: { content: [{ type: 'text', text: 'Button installed' }] },
          });
        }
      }),
    );

    const result = await callMcpToolOnce(
      { ...base(), method: 'tools/call', tool: 'install_components', toolArguments: { components: ['button'] } },
      { spawnProcess: () => server.child, platform: 'linux' },
    );

    expect(result.text).toBe('Button installed');
    expect(result.isError).toBe(false);
    // The handshake happened in order, and the notification was sent.
    const sent = server.writes.join('');
    expect(sent).toContain('"method":"initialize"');
    expect(sent).toContain('"method":"notifications/initialized"');
    expect(sent).toContain('"method":"tools/call"');
  });

  it('keeps the licence key out of argv — it only travels over stdio', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/call') {
          emit({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'activated' }] } });
        }
      }),
    );
    let seenArgs: readonly string[] = [];

    await callMcpToolOnce(
      {
        ...base(),
        method: 'tools/call',
        tool: 'activate_license',
        toolArguments: { licenseKey: 'BUI-SECRET-9999' },
      },
      {
        spawnProcess: (_command, args) => {
          seenArgs = args;
          return server.child;
        },
        platform: 'linux',
      },
    );

    expect(seenArgs.join(' ')).not.toContain('BUI-SECRET-9999');
    expect(server.writes.join('')).toContain('BUI-SECRET-9999');
  });

  it('lists tools without a tool name', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/list') {
          emit({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_theme' }] } });
        }
      }),
    );

    const result = await callMcpToolOnce(
      { ...base(), method: 'tools/list' },
      { spawnProcess: () => server.child, platform: 'linux' },
    );

    expect(result.result.tools).toEqual([{ name: 'get_theme' }]);
  });

  it('requires a tool name for tools/call', async () => {
    await expect(
      callMcpToolOnce({ ...base(), method: 'tools/call' }, { platform: 'linux' }),
    ).rejects.toThrow(/needs a tool name/);
  });

  it('surfaces a JSON-RPC error from the tool', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/call') {
          emit({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'licence not active' } });
        }
      }),
    );

    await expect(
      callMcpToolOnce(
        { ...base(), method: 'tools/call', tool: 'get_component', toolArguments: {} },
        { spawnProcess: () => server.child, platform: 'linux' },
      ),
    ).rejects.toThrow(/licence not active/);
  });

  it('reports a tool result flagged as an error', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/call') {
          emit({
            jsonrpc: '2.0',
            id: 2,
            result: { isError: true, content: [{ type: 'text', text: 'Pro item needs a licence' }] },
          });
        }
      }),
    );

    const result = await callMcpToolOnce(
      { ...base(), method: 'tools/call', tool: 'get_component', toolArguments: { name: 'line-chart' } },
      { spawnProcess: () => server.child, platform: 'linux' },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('needs a licence');
  });

  it('ignores a non-JSON banner line on stdout', async () => {
    const server = fakeServer(
      handshake((message, emit) => {
        if (message.method === 'tools/call') {
          emit({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } });
        }
      }),
    );
    // A banner before the handshake answer must not break the parse.
    server.child.stdout?.emit('data', Buffer.from('BoardUI MCP v1\n', 'utf8'));

    const result = await callMcpToolOnce(
      { ...base(), method: 'tools/call', tool: 'get_started', toolArguments: {} },
      { spawnProcess: () => server.child, platform: 'linux' },
    );

    expect(result.text).toBe('ok');
  });

  it('fails when the server exits before answering', async () => {
    const server = fakeServer((message, _emit, close) => {
      if (message.method === 'initialize') close();
    });

    await expect(
      callMcpToolOnce(
        { ...base(), method: 'tools/call', tool: 'license_status', toolArguments: {} },
        { spawnProcess: () => server.child, platform: 'linux' },
      ),
    ).rejects.toThrow(UiKitCliError);
  });

  it('rejects an already-aborted call before spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;

    await expect(
      callMcpToolOnce(
        { ...base(), method: 'tools/list', signal: controller.signal },
        {
          spawnProcess: () => {
            spawned = true;
            return fakeServer(() => {}).child;
          },
          platform: 'linux',
        },
      ),
    ).rejects.toThrow(/aborted/);
    expect(spawned).toBe(false);
  });
});

describe('mcpResultText', () => {
  it('joins text blocks and skips non-text content', () => {
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'xxx' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond');
  });

  it('is empty when there is no content', () => {
    expect(mcpResultText({})).toBe('');
  });
});

describe('a broken stdin pipe', () => {
  it('rejects the call instead of throwing in the main process', async () => {
    // `Writable.write()` reports EPIPE ASYNCHRONOUSLY: it arrives on the
    // stream, not in the try/catch around the write. With no listener on
    // stdin, that became an uncaught exception in the Electron main process
    // — the whole app — instead of a refused tool call.
    const server = fakeServer(() => {
      // Answers nothing: the pipe breaks mid-handshake.
    });
    const call = callMcpToolOnce(
      { ...base(), method: 'tools/call', tool: 'license_status' },
      { spawnProcess: () => server.child, platform: 'linux' },
    );
    server.stdin.emit('error', new Error('write EPIPE'));

    await expect(call).rejects.toThrow(UiKitCliError);
    await expect(call).rejects.toThrow(/EPIPE/);
  });

  it('reports a write refused through the callback', async () => {
    const server = fakeServer(() => {});
    (server.stdin as unknown as { write: unknown }).write = (
      _chunk: string,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.(new Error('write EPIPE from callback'));
    };

    await expect(
      callMcpToolOnce(
        { ...base(), method: 'tools/call', tool: 'license_status' },
        { spawnProcess: () => server.child, platform: 'linux' },
      ),
    ).rejects.toThrow(/EPIPE from callback/);
  });
});
