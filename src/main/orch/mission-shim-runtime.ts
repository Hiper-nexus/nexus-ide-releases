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
  dispose(): void;
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

function discardDirectoryEntry(parent: string, name: string): void {
  if (name === "." || name === ".." || path.basename(name) !== name) return;
  const entry = path.join(parent, name);
  try {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.rmSync(entry, { recursive: true, force: true });
    } else {
      fs.unlinkSync(entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mission-shim] failed to discard invalid request", error);
    }
  }
}

function isActiveRequestTemp(
  parent: string,
  name: string,
  now: number,
): boolean {
  if (!REQUEST_TEMP_FILE_RE.test(name)) return false;
  try {
    const stat = fs.lstatSync(path.join(parent, name));
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
  for (const command of ["nx-mail", "nx-task", "nx-notify"] as const) {
    if (process.platform === "win32") {
      writePrivateFileAtomic(
        path.join(binDir, `${command}.cmd`),
        `@echo off\r\nnode "%~dp0\\nx-shim.cjs" ${command.slice(3)} %*\r\n`,
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
      args: pickArgs(request.args, ["includeDelivered"]),
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
  ): Promise<void> => {
    let response: ToolDispatchResult = denied("invalid_request");
    try {
      const stat = fs.lstatSync(claimedPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > MAX_REQUEST_BYTES
      ) {
        response = denied("invalid_request");
      } else {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const fd = fs.openSync(claimedPath, fs.constants.O_RDONLY | noFollow);
        try {
          const opened = fs.fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.size > MAX_REQUEST_BYTES
          ) {
            response = denied("invalid_request");
          } else {
            const text = fs.readFileSync(fd, "utf8");
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
              response = await processRequest(parsed.data);
            }
          }
        } finally {
          fs.closeSync(fd);
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
        fs.unlinkSync(claimedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            "[mission-shim] failed to remove claimed request",
            error,
          );
        }
      }
    }
    if (disposed) return;
    try {
      writePrivateFileAtomic(
        path.join(responsesDir, `${expectedRequestId}.json`),
        `${JSON.stringify(response)}\n`,
        0o600,
      );
    } catch (error) {
      console.warn("[mission-shim] failed to write response", error);
    }
  };

  const scan = async (): Promise<void> => {
    if (disposed || scanning) return scanning ?? Promise.resolve();
    scanning = (async () => {
      let names: string[];
      try {
        names = fs.readdirSync(requestsDir).sort();
      } catch (error) {
        if (!disposed)
          console.warn("[mission-shim] request scan failed", error);
        return;
      }
      for (const name of names) {
        const match = REQUEST_FILE_RE.exec(name);
        const source = path.join(requestsDir, name);
        if (!match) {
          if (isActiveRequestTemp(requestsDir, name, now())) continue;
          discardDirectoryEntry(requestsDir, name);
          continue;
        }
        try {
          const stat = fs.lstatSync(source);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            discardDirectoryEntry(requestsDir, name);
            continue;
          }
        } catch {
          continue;
        }
        const claimed = path.join(processingDir, name);
        try {
          fs.renameSync(source, claimed);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("[mission-shim] failed to claim request", error);
          }
          continue;
        }
        try {
          await responseFor(claimed, match[2], Number(match[1]));
        } catch (error) {
          if (!disposed) {
            console.warn("[mission-shim] request processing failed", error);
          }
        }
      }
    })().finally(() => {
      scanning = null;
    });
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
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      sessionId = null;
      seenRequestIds.clear();
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch (error) {
        console.warn("[mission-shim] failed to remove private runtime", error);
      }
    },
    scanNowForTests: scan,
    createRequestForTests: createSignedRequest,
    processRequestForTests: processRequest,
  };
}
