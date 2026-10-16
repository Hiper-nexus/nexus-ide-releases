import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readJsonObject } from '../orch/cli-mcp-session-artifacts';
import { splitQuotedArgv } from './mcp-hub-core';
import { MCP_PROTOCOL_VERSION, type JsonRpcRequest, type JsonRpcResponse } from '../orch/mcp-protocol';
import { mergeWindowsUserEnvironment } from '../pty/windows-user-env';

/**
 * Shared MCP stdio hub (07645-mcp-hub-compartilhado): every operator-hand
 * pane used to spawn its OWN copy of every stdio server declared in the
 * native `~/.claude.json` (`npm exec pkg@latest` + the real server), ~590 MB
 * per pane. This module spawns each stdio server ONCE (lazy, first request)
 * and multiplexes N HTTP callers (one per pane bearer token) against it —
 * the HTTP wiring lives in mcp-server.ts, hooks-gen.ts points panes at
 * `/hub/<key>` instead of copying command/args.
 */

const DEFAULT_RESPAWN_BACKOFF_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** ponytail: a backend that never completes a frame within 8 MB is wedged
 * or malicious — drop the buffer instead of growing forever. No backpressure
 * beyond that; upgrade path is a hard byte cap per in-flight tools/call. */
const MAX_FRAME_BUFFER_BYTES = 8 * 1024 * 1024;

const HUB_CLIENT_INFO = Object.freeze({ name: 'nexus-ide-mcp-hub', version: '1' });

/** Env a spawned backend needs to find node/npm/python + a writable HOME,
 * case-insensitive so Windows' `Path`/`Path` casing still matches. The
 * user's own declared `env` (below) always wins on collision. */
const INHERITED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'USER',
  'USERNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
]);

export interface McpStdioServerDescriptor {
  readonly key: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Diretório de trabalho declarado na entrada original (F-1366). */
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

/** What hooks-gen needs to rewrite native stdio entries into hub HTTP entries. */
export interface McpHubRouteInfo {
  readonly baseUrl: string;
  readonly keys: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Stand-in for the design's `feature.mcp.sharedHub` flag
 * (src/shared/feature-flags.ts, defaultEnabled true). That registry file is
 * outside this change's edit allowlist (07645-mcp-hub-compartilhado.md
 * REGRAS) — wiring a real FeatureFlagDefinition entry there, with the
 * Settings › Labs kill switch, is a follow-up for whoever owns that file.
 * Until then this env escape hatch keeps the same default (opt-out, never
 * opt-in-required) so the bridge can be killed without a rebuild.
 */
export function isMcpSharedHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXUS_MCP_SHARED_HUB_DISABLED !== '1';
}

/**
 * True when `value` is a stdio-shaped `mcpServers` entry: no `url`, a
 * non-empty `command`, and (if present) an explicit `type` of `stdio`. Same
 * predicate shape as the workspace hub's `isStdioHubServer`
 * (mcp-hub-spawn.ts:116-119), reimplemented here because that entry is
 * unvalidated raw JSON from `~/.claude.json`, not the hub's own zod schema.
 */
export function isStdioMcpServerEntry(
  value: unknown,
): value is { command: string; args?: unknown; cwd?: unknown; env?: unknown } {
  const entry = asRecord(value);
  if (typeof entry.type === 'string' && entry.type !== 'stdio') return false;
  if (typeof entry.url === 'string' && entry.url.length > 0) return false;
  return typeof entry.command === 'string' && entry.command.length > 0;
}

/** Extracts bridgeable stdio descriptors from an already-parsed `mcpServers` object. */
export function nativeStdioServerDescriptors(
  mcpServers: unknown,
): readonly McpStdioServerDescriptor[] {
  const out: McpStdioServerDescriptor[] = [];
  for (const [key, value] of Object.entries(asRecord(mcpServers))) {
    if (!isStdioMcpServerEntry(value)) continue;
    const entry = value as { command: string; args?: unknown; cwd?: unknown; env?: unknown };
    let command = entry.command;
    let args = Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === 'string')
      : [];
    // F-1365: `~/.claude.json` do operador pode carregar o argv inteiro no
    // command ("npx pkg@latest", forma que o Cursor gravou) — o hub bridge
    // spawn direto sem shell, então a string inteira seria o argv0 (ENOENT).
    if (/\s/.test(command) && args.length === 0) {
      const argv = splitQuotedArgv(command);
      if (argv.length > 0) {
        command = argv[0]!;
        args = argv.slice(1);
      }
    }
    const env: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(asRecord(entry.env))) {
      if (typeof envValue === 'string') env[envKey] = envValue;
    }
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd : undefined;
    out.push({
      key,
      command,
      args: Object.freeze(args),
      ...(cwd ? { cwd } : {}),
      env: Object.freeze(env),
    });
  }
  return Object.freeze(out);
}

function nativeProfilePath(homedir: string): string {
  return path.join(homedir, '.claude.json');
}

/** Reads `~/.claude.json` and resolves the one stdio descriptor for `key`, or null. */
export function resolveNativeStdioServerDescriptor(
  key: string,
  homedir: string = os.homedir(),
): McpStdioServerDescriptor | null {
  const profile = readJsonObject(nativeProfilePath(homedir));
  return (
    nativeStdioServerDescriptors(profile.mcpServers).find(
      (descriptor) => descriptor.key === key,
    ) ?? null
  );
}

/** Keys of every bridgeable stdio server in the native profile, for hooks-gen's URL list. */
export function resolveMcpHubBridgeKeys(homedir: string = os.homedir()): readonly string[] {
  const profile = readJsonObject(nativeProfilePath(homedir));
  return nativeStdioServerDescriptors(profile.mcpServers).map((d) => d.key);
}

/**
 * Rewrites the operator overlay's `mcpServers` so each bridgeable stdio
 * entry points at the hub instead of carrying its own command/args — the
 * narrow trecho hooks-gen.ts calls. Entries not in `bridge.keys`, non-stdio
 * entries (already http/sse), and a missing `bridge` all pass through
 * unchanged (current behavior: copy stdio verbatim).
 */
export function projectMcpServersThroughHub(
  mcpServers: unknown,
  token: string,
  bridge: McpHubRouteInfo | undefined,
): unknown {
  if (!bridge || bridge.keys.length === 0) return mcpServers;
  const bridgeable = new Set(bridge.keys);
  const source = asRecord(mcpServers);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      bridgeable.has(key) && isStdioMcpServerEntry(value)
        ? {
            type: 'http',
            url: `${bridge.baseUrl}/${encodeURIComponent(key)}`,
            headers: { Authorization: `Bearer ${token}` },
          }
        : value;
  }
  return out;
}

function backendEnv(descriptorEnv: Readonly<Record<string, string>>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && INHERITED_ENV_KEYS.has(key.toUpperCase())) {
      base[key] = value;
    }
  }
  // Windows: o backend de um MCP stdio declarado em `~/.claude.json` muitas
  // vezes depende de variáveis do PRÓPRIO operador (ex.: MARGEM_MCP_READ_URL /
  // MARGEM_MCP_READ_TOKEN). Elas vivem em `HKCU\Environment` e o `process.env`
  // do Main não as vê; sem isto o hub subia o servidor sem credencial e falhava
  // em silêncio. Preenche lacunas — o `env` declarado no descriptor continua
  // vencendo (spread abaixo) e o INHERITED_ENV_KEYS acima tem precedência.
  mergeWindowsUserEnvironment(base);
  return { ...base, ...descriptorEnv };
}

// ── stdio framing ────────────────────────────────────────────────────────

type FramingMode = 'unknown' | 'ndjson' | 'content-length';

/**
 * Auto-detects the backend's OWN framing from what it actually sends
 * (newline-delimited JSON — what `@modelcontextprotocol/sdk`'s stdio
 * transport speaks — or LSP-style `Content-Length` headers for any backend
 * that doesn't). We always WRITE ndjson to the backend (spec-compliant,
 * matches every real MCP stdio server observed); this reader only needs to
 * cope with what comes back.
 */
class StdioFrameReader {
  private mode: FramingMode = 'unknown';
  private buffer = '';

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > MAX_FRAME_BUFFER_BYTES) {
      this.buffer = '';
      return;
    }
    if (this.mode === 'unknown') this.detectMode();
    if (this.mode === 'ndjson') this.drainNdjson();
    else if (this.mode === 'content-length') this.drainContentLength();
  }

  private detectMode(): void {
    const probe = this.buffer.trimStart();
    if (probe.length === 0) return;
    this.mode = /^content-length:/i.test(probe) ? 'content-length' : 'ndjson';
  }

  private drainNdjson(): void {
    let newlineAt = this.buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt).trim();
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.length > 0) this.parse(line);
      newlineAt = this.buffer.indexOf('\n');
    }
  }

  private drainContentLength(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = /content-length:\s*(\d+)/i.exec(header);
      const bodyStart = headerEnd + 4;
      if (!match) {
        this.buffer = this.buffer.slice(bodyStart);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      this.parse(body);
    }
  }

  private parse(raw: string): void {
    try {
      this.onMessage(JSON.parse(raw));
    } catch {
      // Malformed frame from the backend — nothing to address a response to; drop.
    }
  }
}

// ── one backend process, N HTTP callers ─────────────────────────────────

interface BackendResponseEnvelope {
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

interface PendingEntry {
  readonly onResponse: (raw: BackendResponseEnvelope) => void;
  readonly onFail: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CachedInit {
  readonly protocolVersion: string;
  readonly capabilities: unknown;
  readonly serverInfo: unknown;
}

function errorResponse(id: JsonRpcResponse['id'], message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } };
}

export interface McpStdioChannelOptions {
  readonly respawnBackoffMs?: number;
  readonly requestTimeoutMs?: number;
}

/** One spawned backend process for one native stdio server, shared by every caller. */
class McpStdioChannel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextInternalId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private cachedInit: CachedInit | null = null;
  private initializing: Promise<CachedInit> | null = null;
  private nextAttemptAllowedAt = 0;

  constructor(
    private readonly descriptor: McpStdioServerDescriptor,
    private readonly options: McpStdioChannelOptions = {},
  ) {}

  private get respawnBackoffMs(): number {
    return this.options.respawnBackoffMs ?? DEFAULT_RESPAWN_BACKOFF_MS;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (typeof message.method !== 'string') {
      return errorResponse(message.id ?? null, 'invalid request: missing method');
    }
    // Client notifications never reach the backend: the bridge already ran
    // its own initialize/notifications-initialized handshake once, so a
    // second `notifications/initialized` from a later client has nothing
    // left to tell the backend.
    if (message.method.startsWith('notifications/')) return null;
    if (message.method === 'initialize') {
      try {
        const init = await this.ensureBackend();
        return { jsonrpc: '2.0', id: message.id ?? null, result: init };
      } catch (error) {
        return errorResponse(message.id ?? null, bridgeErrorMessage(error));
      }
    }
    try {
      await this.ensureBackend();
    } catch (error) {
      return errorResponse(message.id ?? null, bridgeErrorMessage(error));
    }
    // OVKA-754 (padrão boardRelay): listagens idempotentes repetem quando a
    // resposta se perde no transporte (timeout/erro de frame) — a sessão não
    // pode ficar com tools/list mudo. `tools/call` NUNCA é repetido (muda
    // estado; retry cega duplicaria task_claim/deliver).
    const idempotentListing =
      message.method === 'tools/list' || message.method === 'ping';
    if (!idempotentListing) return this.forward(message);
    let last: JsonRpcResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await this.forward(message);
      const lostInTransit =
        last.error &&
        /timed out|transport|exited|EPIPE/i.test(last.error.message ?? '');
      if (!lostInTransit) return last;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return (
      last ??
      errorResponse(message.id ?? null, `listagem perdida no transporte (${message.method})`)
    );
  }

  dispose(): void {
    this.resetState(new Error(`backend "${this.descriptor.key}" was disposed`), false);
  }

  private ensureBackend(): Promise<CachedInit> {
    if (this.cachedInit) return Promise.resolve(this.cachedInit);
    if (this.initializing) return this.initializing;
    if (Date.now() < this.nextAttemptAllowedAt) {
      return Promise.reject(
        new Error(`backend "${this.descriptor.key}" is cooling down after a recent failure`),
      );
    }
    const attempt = this.spawnAndInitialize().finally(() => {
      this.initializing = null;
    });
    this.initializing = attempt;
    return attempt;
  }

  private async spawnAndInitialize(): Promise<CachedInit> {
    try {
      const child = spawn(this.descriptor.command, [...this.descriptor.args], {
        env: backendEnv(this.descriptor.env),
        // F-1366: command relativo resolve contra o cwd declarado na entrada,
        // não contra o cwd do processo do hub.
        ...(this.descriptor.cwd ? { cwd: this.descriptor.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows resolves npm-installed shims (npx.cmd, etc.) through the
        // shell; every other platform spawns the binary directly.
        shell: process.platform === 'win32',
      });
      this.child = child;
      const reader = new StdioFrameReader((raw) => this.onBackendMessage(raw));
      child.stdout.on('data', (chunk: Buffer) => reader.push(chunk));
      child.stderr.on('data', () => {
        // Backend stderr is diagnostic noise from a third-party process —
        // never parsed, never surfaced to the pane (it isn't JSON-RPC).
      });
      child.once('exit', () => {
        this.resetState(new Error(`backend "${this.descriptor.key}" exited`), true);
      });
      child.once('error', (error) => {
        this.resetState(error instanceof Error ? error : new Error(String(error)), true);
      });
      const initResult = asRecord(
        await this.call('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: HUB_CLIENT_INFO,
        }),
      );
      this.writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const init: CachedInit = {
        protocolVersion:
          typeof initResult.protocolVersion === 'string'
            ? initResult.protocolVersion
            : MCP_PROTOCOL_VERSION,
        capabilities: initResult.capabilities ?? {},
        serverInfo: initResult.serverInfo ?? { name: this.descriptor.key, version: 'unknown' },
      };
      this.cachedInit = init;
      return init;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.resetState(failure, true);
      throw failure;
    }
  }

  /** One request the BRIDGE makes of the backend (only used for `initialize`). */
  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextInternalId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`backend "${this.descriptor.key}" timed out on ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        onResponse: (raw) => {
          if (raw.error) reject(new Error(raw.error.message));
          else resolve(raw.result);
        },
        onFail: reject,
        timer,
      });
      this.writeMessage({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** A caller's request, forwarded with a fresh internal id and translated back. */
  private forward(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const originalId = message.id ?? null;
    return new Promise((resolve) => {
      const id = this.nextInternalId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          errorResponse(
            originalId,
            `backend "${this.descriptor.key}" timed out on ${message.method}`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        onResponse: (raw) => {
          resolve(
            raw.error
              ? { jsonrpc: '2.0', id: originalId, error: raw.error }
              : { jsonrpc: '2.0', id: originalId, result: raw.result },
          );
        },
        onFail: (error) => resolve(errorResponse(originalId, error.message)),
        timer,
      });
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onBackendMessage(raw: unknown): void {
    const message = asRecord(raw);
    const hasMethod = typeof message.method === 'string';
    const hasId = message.id !== undefined && message.id !== null;
    const isResponseShaped = 'result' in message || 'error' in message;
    if (!hasMethod && isResponseShaped) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const entry = Number.isFinite(id) ? this.pending.get(id) : undefined;
      if (!entry) return; // response to an id we no longer track (timed out); ignore.
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.onResponse({
        result: message.result,
        error: message.error as BackendResponseEnvelope['error'],
      });
      return;
    }
    if (hasMethod && !hasId) {
      // Notification FROM the backend (progress/list_changed/logging/…).
      // ponytail: no push channel exists on this POST-only HTTP transport
      // (same ceiling as Nexus's own embedded /mcp, mcp-server.ts:431-434
      // "SSE stream not supported") — dropped, not delivered. Upgrade path
      // is an SSE stream once a caller actually needs server-pushed events.
      return;
    }
    if (hasMethod && hasId) {
      // Backend-initiated REQUEST (sampling/createMessage, elicitation,
      // roots/list…). Never leave it hanging — refuse over the SAME stdio
      // channel immediately.
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `${String(message.method)} is not supported by the shared MCP hub`,
        },
      });
    }
  }

  private resetState(error: Error, applyBackoff: boolean): void {
    const child = this.child;
    this.child = null;
    this.cachedInit = null;
    if (applyBackoff) {
      this.nextAttemptAllowedAt = Date.now() + this.respawnBackoffMs;
      console.warn(`[mcp-hub] backend "${this.descriptor.key}" is down: ${error.message}`);
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.onFail(error);
    }
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        // Best effort — process may already be gone.
      }
    }
  }
}

function bridgeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Multiplexes every `/hub/<key>` caller onto one channel per key. */
export class McpStdioBridge {
  private readonly channels = new Map<string, McpStdioChannel>();

  constructor(private readonly options: McpStdioChannelOptions = {}) {}

  handle(
    descriptor: McpStdioServerDescriptor,
    message: JsonRpcRequest,
  ): Promise<JsonRpcResponse | null> {
    let channel = this.channels.get(descriptor.key);
    if (!channel) {
      channel = new McpStdioChannel(descriptor, this.options);
      this.channels.set(descriptor.key, channel);
    }
    return channel.handle(message);
  }

  disposeAll(): void {
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
  }
}
