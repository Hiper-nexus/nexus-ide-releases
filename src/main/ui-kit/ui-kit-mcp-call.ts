import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import {
  assertSafeUiKitCwd,
  buildUiKitChildEnv,
  isAlreadyGoneKillError,
  resolveUiKitNpxLaunch,
  UiKitCliError,
  UI_KIT_PACKAGES,
  type UiKitId,
} from './ui-kit-cli';

/**
 * A one-shot MCP client: spawn a stdio MCP server, initialize, call ONE tool,
 * read the result, tear the process down.
 *
 * This exists because BoardUI's surface is its MCP server, not its CLI. The CLI
 * has `init` and `add`; the catalog, the per-item source, the usage examples,
 * the theme tokens, the design rules and the whole Pro licence lifecycle
 * (`activate_license`, `license_status`, `deactivate_license`) are MCP tools.
 * Reaching them is the only way "every feature of both kits is used" is true.
 *
 * It is also the right transport for the licence key specifically: a key passed
 * as `npx boardui login <key>` is world-readable in `ps` for every local
 * process. Over stdio it is not in argv at all — the same rule the Windows
 * signing agent follows for its PIN.
 *
 * Framing is the MCP stdio transport: one JSON-RPC object per line.
 *
 * It takes NO command, argv or env from a caller. Those are built here from
 * the same helpers `runUiKitCli` uses, so both doors into a vendor CLI pass
 * the same gate: a fixed `npx -y <pinned package> mcp`, the env allowlist, and
 * the cwd guard that refuses a writing run inside a shared `node_modules`. An
 * exported function that spawned an arbitrary command would be a hole straight
 * past all of it.
 */

export const UI_KIT_MCP_PROTOCOL_VERSION = '2025-06-18';
export const UI_KIT_MCP_TIMEOUT_MS = 180_000;
export const UI_KIT_MCP_MAX_OUTPUT_BYTES = 8_000_000;
export const UI_KIT_MCP_MAX_LINE_BYTES = 4_000_000;
export const UI_KIT_MCP_TERMINATION_GRACE_MS = 2_000;

export type McpOneShotMethod = 'tools/call' | 'tools/list';

/** An MCP tool name: lowercase, digits and underscores. */
export const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MCP_MAX_TOOL_NAME_CHARS = 64;

export interface McpOneShotRequest {
  /** Which vendor's MCP server. The package is pinned per kit, not passed in. */
  readonly kit: UiKitId;
  /** Project directory; guarded exactly as a CLI run is. */
  readonly cwd: string;
  /** True when the tool writes the project or changes licence state. */
  readonly writes?: boolean;
  readonly method: McpOneShotMethod;
  /** Required for `tools/call`. */
  readonly tool?: string;
  readonly toolArguments?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function assertMcpToolName(raw: string): string {
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > MCP_MAX_TOOL_NAME_CHARS ||
    !MCP_TOOL_NAME_PATTERN.test(value)
  ) {
    throw new UiKitCliError(
      'INVALID_TOOL_NAME',
      `an MCP tool name must match ${String(MCP_TOOL_NAME_PATTERN)} and stay ` +
        `under ${MCP_MAX_TOOL_NAME_CHARS} characters`,
    );
  }
  return value;
}

export interface McpToolContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface McpOneShotResult {
  /** The raw `result` object of the JSON-RPC response. */
  readonly result: Record<string, unknown>;
  /** Concatenated text of every text content block, for display. */
  readonly text: string;
  /** True when the server flagged the tool call as an error. */
  readonly isError: boolean;
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface McpOneShotOptions {
  /** Injected in tests so no suite spawns a real MCP server. */
  readonly spawnProcess?: SpawnLike;
  readonly platform?: NodeJS.Platform;
}

/** Pull the display text out of an MCP tool result's content blocks. */
export function mcpResultText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const candidate = block as McpToolContentBlock;
      if (typeof candidate.text === 'string' && candidate.text.length > 0) {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join('\n');
}

async function terminateTree(
  pid: number | undefined,
  platform: NodeJS.Platform,
): Promise<void> {
  if (pid === undefined) return;
  if (platform === 'win32') {
    const taskkill = path.win32.join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // SIGKILL below is the authoritative stop.
  }
  // NOT unref'd: the caller's settlement is sequenced behind this grace.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, UI_KIT_MCP_TERMINATION_GRACE_MS);
  });
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!isAlreadyGoneKillError(error)) {
      console.warn(`[ui-kit-mcp] failed to kill process group ${pid}:`, error);
    }
  }
}

/**
 * Call one tool on a stdio MCP server and return its result.
 *
 * Nothing from `toolArguments` is ever logged: it carries the licence key.
 */
export async function callMcpToolOnce(
  request: McpOneShotRequest,
  options: McpOneShotOptions = {},
): Promise<McpOneShotResult> {
  if (request.method === 'tools/call' && !request.tool) {
    throw new UiKitCliError('NO_TOOL', 'tools/call needs a tool name');
  }
  const tool =
    request.tool === undefined ? undefined : assertMcpToolName(request.tool);
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = request.timeoutMs ?? UI_KIT_MCP_TIMEOUT_MS;
  // Same gate as a CLI run: a writing tool may not land in a checkout whose
  // node_modules is a shared symlink.
  const cwd = assertSafeUiKitCwd(request.cwd, { writes: request.writes === true });
  const launch = resolveUiKitNpxLaunch({ platform });
  const args = [...launch.argsPrefix, '-y', UI_KIT_PACKAGES[request.kit], 'mcp'];
  const env = buildUiKitChildEnv();

  if (request.signal?.aborted) {
    throw new UiKitCliError('ABORTED', 'MCP call aborted');
  }

  return await new Promise<McpOneShotResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(launch.command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        shell: false,
        windowsHide: platform === 'win32',
      });
    } catch (error) {
      reject(
        new UiKitCliError(
          'SPAWN_FAILED',
          `failed to spawn MCP server: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }

    let settled = false;
    let buffer = '';
    let bytes = 0;
    let stderr = '';
    let initialized = false;

    const timer = setTimeout(() => {
      fail(new UiKitCliError('TIMEOUT', `MCP call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    function onStdinError(error: Error): void {
      // `Writable.write()` reports EPIPE ASYNCHRONOUSLY: when the server
      // closes its input pipe (during the handshake, say), the failure
      // arrives on the stream, not in the try/catch around the write. With no
      // listener here it became an uncaught exception in the MAIN process
      // instead of a rejected tool call.
      fail(
        new UiKitCliError(
          'WRITE_FAILED',
          `failed to write to MCP server: ${error.message}`,
        ),
      );
    }

    function cleanup(): void {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: UiKitCliError): void {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateTree(child.pid, platform)
        .catch(() => {})
        .finally(() => reject(error));
    }
    function succeed(value: McpOneShotResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateTree(child.pid, platform)
        .catch(() => {})
        .finally(() => resolve(value));
    }
    function onAbort(): void {
      fail(new UiKitCliError('ABORTED', 'MCP call aborted'));
    }
    function send(message: Record<string, unknown>): void {
      try {
        // The callback catches the same asynchronous failure on this write;
        // the stream listener covers one that arrives between writes.
        child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) onStdinError(error);
        });
      } catch (error) {
        fail(
          new UiKitCliError(
            'WRITE_FAILED',
            `failed to write to MCP server: ` +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
      }
    }

    child.stdin?.on('error', onStdinError);
    // A Writable invokes its failed write callback BEFORE emitting 'error'.
    // Settling the call in that callback must not expose a later EPIPE to
    // Main. Keep the listener until the stream itself finishes closing.
    child.stdin?.once('close', () => child.stdin?.off('error', onStdinError));
    request.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new UiKitCliError(
          'SPAWN_FAILED',
          `failed to run MCP server: ${error.message}`,
          'Ensure Node and npx are available on PATH.',
        ),
      );
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // Kept only to frame a failure; capped so a chatty server cannot grow
      // the main process's heap.
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });

    child.once('close', () => {
      fail(
        new UiKitCliError(
          'MCP_CLOSED',
          `MCP server exited before answering${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`,
        ),
      );
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > UI_KIT_MCP_MAX_OUTPUT_BYTES) {
        fail(
          new UiKitCliError(
            'OUTPUT_TOO_LARGE',
            `MCP output exceeded ${UI_KIT_MCP_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      buffer += chunk.toString('utf8');
      if (buffer.length > UI_KIT_MCP_MAX_LINE_BYTES) {
        fail(
          new UiKitCliError(
            'OUTPUT_TOO_LARGE',
            'MCP server sent an oversized line',
          ),
        );
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) handleLine(line);
        if (settled) return;
        newline = buffer.indexOf('\n');
      }
    });

    function handleLine(line: string): void {
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        // Servers print banners on stdout; a non-JSON line is not fatal.
        return;
      }
      const id = message.id;
      if (id !== 1 && id !== 2) return;

      const error = message.error;
      if (error && typeof error === 'object') {
        const detail = error as { message?: unknown; code?: unknown };
        const text =
          typeof detail.message === 'string' ? detail.message : 'unknown error';
        fail(
          new UiKitCliError(
            id === 1 ? 'MCP_INITIALIZE_FAILED' : 'MCP_TOOL_FAILED',
            `MCP server refused: ${text.slice(0, 400)}`,
          ),
        );
        return;
      }

      if (id === 1) {
        if (initialized) return;
        initialized = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const params: Record<string, unknown> =
          request.method === 'tools/call'
            ? { name: tool, arguments: request.toolArguments ?? {} }
            : {};
        send({ jsonrpc: '2.0', id: 2, method: request.method, params });
        return;
      }

      const result =
        message.result && typeof message.result === 'object'
          ? (message.result as Record<string, unknown>)
          : {};
      succeed({
        result,
        text: mcpResultText(result),
        isError: result.isError === true,
      });
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: UI_KIT_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nexus-ide', version: '1' },
      },
    });
  });
}
