import fsp from 'node:fs/promises';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  getContextBySession,
  isCurrentGateContext,
  type AgentGateContext,
} from "./gate";
import { runInsideMissionShimTransport } from "./http-mcp-boundary";
import type { ToolDispatchResult } from "./mcp-dispatch-contract";

const REQUEST_SCHEMA = "nexus.mission-shim-request/v1";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 40;
const REQUEST_FILE_RE =
  /^(\d{16})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu;
const REQUEST_TEMP_FILE_RE =
  /^\.\d{16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;
const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"));
const argsSchema = z.record(z.string(), z.unknown());

/**
 * Windows workers run inside an OCI filesystem whose only host mounts are the
 * checkout and its private sandbox runtime. Until that boundary can remap the
 * shim PATH and capability environment into the container, installing a host
 * dropbox would make the worker fail closed before spawn. Keep the existing
 * MCP/transcript fallbacks alive instead of turning an optional transport into
 * a liveness gate.
 */
export function isMissionShimSandboxSupported(
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin" || platform === "linux";
}

const requestSchema = z
  .object({
    schema: z.literal(REQUEST_SCHEMA),
    capabilityId: z.uuid(),
    requestId: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    issuedAt: z.number().int().nonnegative(),
    command: z.enum(["mail", "task", "notify"]),
    operation: identifierSchema,
    args: argsSchema,
    mac: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type MissionShimRequest = z.infer<typeof requestSchema>;

export interface MissionShimInvocation {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

interface MissionShimRuntimeOptions {
  readonly ctx: AgentGateContext;
  readonly invoke: (
    invocation: MissionShimInvocation,
  ) => Promise<ToolDispatchResult>;
  readonly baseDir?: string;
  readonly clientSourcePath?: string;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export interface MissionShimRuntime {
  readonly rootDir: string;
  readonly binDir: string;
  readonly requestsDir: string;
  readonly responsesDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  bindSession(sessionId: string): void;
  dispose(): Promise<void>;
  scanNowForTests(): Promise<void>;
  createRequestForTests(
    input: Omit<MissionShimRequest, "schema" | "capabilityId" | "mac">,
  ): MissionShimRequest;
  processRequestForTests(request: unknown): Promise<ToolDispatchResult>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
  );
}

function signingInput(request: Omit<MissionShimRequest, "mac">): string {
  return JSON.stringify([
    request.schema,
    request.capabilityId,
    request.requestId,
    request.sequence,
    request.issuedAt,
    request.command,
    request.operation,
    canonicalize(request.args),
  ]);
}

function requestMac(
  request: Omit<MissionShimRequest, "mac">,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(signingInput(request))
    .digest("hex");
}

function sameMac(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("mission shim runtime path is not a private directory");
  }
  fs.chmodSync(directory, 0o700);
}

function writePrivateFileAtomic(
  filePath: string,
  content: string,
  mode: number,
): void {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function discardDirectoryEntry(parent: string, name: string): Promise<void> {
  if (name === "." || name === ".." || path.basename(name) !== name) return;
  const entry = path.join(parent, name);
  try {
    const stat = await fsp.lstat(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fsp.rm(entry, { recursive: true, force: true });
    } else {
      await fsp.unlink(entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mission-shim] failed to discard invalid request", error);
    }
  }
}

async function isActiveRequestTemp(
  parent: string,
  name: string,
  now: number,
): Promise<boolean> {
  if (!REQUEST_TEMP_FILE_RE.test(name)) return false;
  try {
    const stat = await fsp.lstat(path.join(parent, name));
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= MAX_REQUEST_BYTES &&
      Math.abs(now - stat.mtimeMs) <= MAX_CLOCK_SKEW_MS
    );
  } catch {
    return false;
  }
}

function resolveClientSource(explicitPath?: string): string {
  const candidates = [
    explicitPath,
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "mission-shims", "nx-shim.cjs")
      : undefined,
    path.resolve(__dirname, "../../../resources/mission-shims/nx-shim.cjs"),
    path.resolve(__dirname, "../../resources/mission-shims/nx-shim.cjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync.native(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {
      // Try the next dev/packaged location.
    }
  }
  throw new Error("mission shim client resource is unavailable");
}

function installClients(binDir: string, sourcePath: string): void {
  const source = fs.readFileSync(sourcePath, "utf8");
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("mission shim client resource is not executable Node.js");
  }
  const sharedClient = path.join(binDir, "nx-shim.cjs");
  writePrivateFileAtomic(sharedClient, source, 0o700);
  // Aliases canônicos (padrão invokta, voo real 19/08): quando o worker sem
  // MCP chuta o NOME DA TOOL no shell, o comando existe e entra no mesmo
  // dispatcher. No Windows o basename visível é o .cmd, então o prefixo do
  // argv faz o papel do basename.
  const commandPrefixByName: Record<string, string> = {
    "nx-mail": "mail",
    "nx-task": "task",
    "nx-notify": "notify",
    nexus: "",
    nexus_handoff_submit: "handoff-submit",
  };
  for (const [command, prefix] of Object.entries(commandPrefixByName)) {
    if (process.platform === "win32") {
      const forwarded = prefix ? `${prefix} %*` : "%*";
      writePrivateFileAtomic(
        path.join(binDir, `${command}.cmd`),
        `@echo off\r\nnode "%~dp0\\nx-shim.cjs" ${forwarded}\r\n`,
        0o700,
      );
    } else {
      writePrivateFileAtomic(path.join(binDir, command), source, 0o700);
    }
  }
}

function mapOperation(request: MissionShimRequest): {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
} | null {
  if (request.command === "mail" && request.operation === "send") {
    return {
      toolName: "nexus_handoff_submit",
      args: pickArgs(request.args, [
        "status",
        "summary",
        "artifacts",
        "evidenceIds",
      ]),
    };
  }
  if (request.command === "mail" && request.operation === "list") {
    return {
      toolName: "nexus_handoff_list",
      args: pickArgs(request.args, ["includeDelivered", "full", "missionId"]),
    };
  }
  if (request.command === "task" && request.operation === "list") {
    return { toolName: "nexus_task", args: { action: "list" } };
  }
  if (request.command === "notify" && request.operation === "heartbeat") {
    return { toolName: "nexus_worker_heartbeat", args: {} };
  }
  return null;
}

function pickArgs(
  args: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    allowedKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
      .map((key) => [key, args[key]]),
  );
}

function denied(error: string): ToolDispatchResult {
  return { ok: false, tool: "mission-shim", denied: true, error };
}

export function createMissionShimRuntime(
  options: MissionShimRuntimeOptions,
): MissionShimRuntime {
  const capabilityId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const baseDir =
    options.baseDir ?? path.join(os.tmpdir(), "nexus-mission-shims-v1");
  ensurePrivateDirectory(baseDir);
  const rootDir = path.join(baseDir, capabilityId);
  const binDir = path.join(rootDir, "bin");
  const requestsDir = path.join(rootDir, "requests");
  const responsesDir = path.join(rootDir, "responses");
  const processingDir = path.join(rootDir, "processing");
  const stateDir = path.join(rootDir, "state");
  for (const directory of [
    rootDir,
    binDir,
    requestsDir,
    responsesDir,
    processingDir,
    stateDir,
  ]) {
    ensurePrivateDirectory(directory);
  }
  installClients(binDir, resolveClientSource(options.clientSourcePath));

  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(
    5,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const seenRequestIds = new Set<string>();
  let lastSequence = 0;
  let sessionId: string | null = null;
  let disposed = false;
  let scanning: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  const controller = new AbortController();
  const taskId = `mission-shim:${capabilityId}`;
  const bindingCurrent = () => !disposed && !!sessionId && options.ctx.sessionId === sessionId &&
    getContextBySession(sessionId) === options.ctx && isCurrentGateContext(options.ctx);
  let timer: NodeJS.Timeout | null = null;

  const createSignedRequest = (
    input: Omit<MissionShimRequest, "schema" | "capabilityId" | "mac">,
  ): MissionShimRequest => {
    const unsigned = {
      schema: REQUEST_SCHEMA,
      capabilityId,
      ...input,
    } as const;
    return { ...unsigned, mac: requestMac(unsigned, secret) };
  };

  const processRequest = async (raw: unknown): Promise<ToolDispatchResult> => {
    if (!bindingCurrent()) return denied("session_authority_revoked");
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return denied("invalid_request");
    const request = parsed.data;
    if (request.capabilityId !== capabilityId) {
      return denied("capability_scope_mismatch");
    }
    const { mac: _mac, ...unsigned } = request;
    if (!sameMac(request.mac, requestMac(unsigned, secret))) {
      return denied("invalid_capability_mac");
    }
    if (seenRequestIds.has(request.requestId))
      return denied("request_replayed");
    if (Math.abs(now() - request.issuedAt) > MAX_CLOCK_SKEW_MS) {
      return denied("request_expired");
    }
    if (request.sequence <= lastSequence) {
      return denied("request_sequence_invalid");
    }
    if (
      !sessionId ||
      options.ctx.sessionId !== sessionId ||
      getContextBySession(sessionId) !== options.ctx ||
      !isCurrentGateContext(options.ctx)
    ) {
      return denied("session_authority_revoked");
    }
    const mapped = mapOperation(request);
    if (!mapped) return denied("operation_not_allowed");
    seenRequestIds.add(request.requestId);
    lastSequence = request.sequence;
    try {
      return await runInsideMissionShimTransport(
        sessionId,
        request.requestId,
        options.ctx,
        () =>
          options.invoke({
            requestId: request.requestId,
            sessionId: sessionId!,
            toolName: mapped.toolName,
            args: mapped.args,
          }),
      );
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error));
    }
  };

  const responseFor = async (
    claimedPath: string,
    expectedRequestId: string,
    expectedSequence: number,
    context: PeriodicTaskContext,
  ): Promise<void> => {
    let response: ToolDispatchResult = denied("invalid_request");
    try {
      const stat = await context.wait(fsp.lstat(claimedPath));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > MAX_REQUEST_BYTES
      ) {
        response = denied("invalid_request");
      } else {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const fd = await fsp.open(claimedPath, fs.constants.O_RDONLY | noFollow);
        try {
          context.assertCurrent();
          const opened = await context.wait(fd.stat());
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.size > MAX_REQUEST_BYTES
          ) {
            response = denied("invalid_request");
          } else {
            const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
            const { bytesRead } = await context.wait(fd.read(buffer, 0, buffer.length, 0));
            if (bytesRead > MAX_REQUEST_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino ||
              !bindingCurrent()) throw new Error('request identity changed');
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            const raw = JSON.parse(text) as unknown;
            const parsed = requestSchema.safeParse(raw);
            if (!parsed.success) {
              response = denied("invalid_request");
            } else if (
              parsed.data.requestId !== expectedRequestId ||
              parsed.data.sequence !== expectedSequence
            ) {
              response = denied("request_filename_mismatch");
            } else {
              response = await context.wait(processRequest(parsed.data));
            }
          }
        } finally {
          await fd.close();
        }
      }
    } catch (error) {
      response = denied(
        error instanceof SyntaxError
          ? "invalid_request"
          : "request_read_failed",
      );
    } finally {
      try {
        await fsp.unlink(claimedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            "[mission-shim] failed to remove claimed request",
            error,
          );
        }
      }
    }
    context.assertCurrent();
    if (!bindingCurrent()) return;
    const target = path.join(responsesDir, `${expectedRequestId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await context.wait(fsp.writeFile(temporary, `${JSON.stringify(response)}\n`, { mode: 0o600, flag: 'wx' }));
      if (!bindingCurrent()) return;
      await context.wait(fsp.rename(temporary, target));
    } catch (error) {
      if (!disposed) console.warn("[mission-shim] failed to write response", error);
    } finally { await fsp.unlink(temporary).catch(() => undefined); }
  };

  const scan = (): Promise<void> => {
    if (disposed || scanning) return scanning ?? Promise.resolve();
    scanning = runPeriodicTask(taskId, async (context) => {
      let directory: Awaited<ReturnType<typeof fsp.opendir>>;
      try { directory = await fsp.opendir(requestsDir, { bufferSize: 32 }); }
      catch { return; }
      const names: string[] = [];
      try {
        for (;;) {
          await context.checkpoint();
          if (!bindingCurrent()) return;
          const entry = await context.wait(directory.read());
          if (!entry) break;
          if (!REQUEST_FILE_RE.test(entry.name)) {
            if (await isActiveRequestTemp(requestsDir, entry.name, now())) continue;
            context.assertCurrent();
            if (!bindingCurrent()) return;
            await context.wait(discardDirectoryEntry(requestsDir, entry.name));
          } else {
            names.push(entry.name);
            names.sort();
            if (names.length > 100) names.pop();
          }
        }
      } finally { await directory.close(); }
      for (const name of names) {
        await context.checkpoint();
        if (!bindingCurrent()) return;
        const match = REQUEST_FILE_RE.exec(name)!;
        const source = path.join(requestsDir, name);
        try {
          const stat = await context.wait(fsp.lstat(source));
          if (!bindingCurrent()) return;
          if (!stat.isFile() || stat.isSymbolicLink()) {
            await context.wait(discardDirectoryEntry(requestsDir, name));
            continue;
          }
        } catch { context.assertCurrent(); continue; }
        const claimed = path.join(processingDir, name);
        try { await context.wait(fsp.rename(source, claimed)); }
        catch { context.assertCurrent(); continue; }
        if (!bindingCurrent()) return;
        await responseFor(claimed, match[2], Number(match[1]), context);
      }
    }, { signal: controller.signal, cadenceMs: pollIntervalMs }).catch((error) => {
      if (!disposed) console.warn('[mission-shim] request processing failed', error);
    }).finally(() => { scanning = null; });
    return scanning;
  };

  return {
    rootDir,
    binDir,
    requestsDir,
    responsesDir,
    env: Object.freeze({
      NEXUS_SHIM_ROOT: rootDir,
      NEXUS_SHIM_CAPABILITY_ID: capabilityId,
      NEXUS_SHIM_SECRET: secret,
    }),
    readPaths: Object.freeze([binDir, responsesDir, requestsDir, stateDir]),
    writePaths: Object.freeze([requestsDir, stateDir]),
    bindSession(boundSessionId) {
      if (disposed) throw new Error("mission shim runtime is disposed");
      if (
        !boundSessionId ||
        options.ctx.sessionId !== boundSessionId ||
        getContextBySession(boundSessionId) !== options.ctx ||
        !isCurrentGateContext(options.ctx)
      ) {
        throw new Error("mission shim requires the exact current PTY session");
      }
      if (sessionId && sessionId !== boundSessionId) {
        throw new Error("mission shim is already bound to another PTY session");
      }
      sessionId = boundSessionId;
      if (!timer) {
        timer = setInterval(() => void scan(), pollIntervalMs);
        timer.unref();
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      controller.abort(new Error('mission shim disposed'));
      sessionId = null;
      disposal = (async () => {
        await stopPeriodicTask(taskId);
        await scanning;
        seenRequestIds.clear();
        await fsp.rm(rootDir, { recursive: true, force: true }).catch((error) =>
          { console.warn('[mission-shim] failed to remove private runtime', error); throw error; });
      })();
      const pending = disposal;
      // Revoke once; a transient filesystem failure may retry deletion without
      // restoring the timer, session authority or command admission.
      void pending.catch(() => { if (disposal === pending) disposal = null; });
      return pending;
    },
    scanNowForTests: scan,
    createRequestForTests: createSignedRequest,
    processRequestForTests: processRequest,
  };
}
