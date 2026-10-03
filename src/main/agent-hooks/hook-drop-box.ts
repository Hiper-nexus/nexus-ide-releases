import fsp from 'node:fs/promises';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestAgentHookStatus } from "./hook-ingest";

export const canonicalHookEnvelopeSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    status: z
      .enum(["running", "idle", "needs-input", "error", "ended"])
      .optional(),
    state: z
      .enum(["working", "blocked", "waiting", "done"])
      .optional(),
    event: z.string().max(128).optional(),
    title: z.string().max(512).optional(),
    body: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
    pid: z.number().int().optional(),
    timestamp: z.number().int().nonnegative(),
    userPrompt: z.string().max(4096).optional(),
    nativeSessionId: z.string().max(512).optional(),
    transcriptPath: z.string().max(4096).optional(),
    configDir: z.string().max(4096).optional(),
    agentType: z.string().max(128).optional(),
    resumeCommand: z.string().max(1024).optional(),
  })
  .passthrough();

export type CanonicalHookEnvelope = z.infer<
  typeof canonicalHookEnvelopeSchema
>;

export function mapCanonicalStatusToAgentState(
  statusOrState?: string,
): "working" | "blocked" | "waiting" | "done" {
  switch (statusOrState) {
    case "running":
    case "working":
      return "working";
    case "needs-input":
    case "waiting":
      return "waiting";
    case "error":
    case "blocked":
      return "blocked";
    case "idle":
    case "ended":
    case "done":
      return "done";
    default:
      return "working";
  }
}

export function resolveDefaultDropBoxDir(): string {
  const home = process.env.NEXUS_USER_HOME || os.homedir();
  return path.join(home, ".nexus", "agent-hooks", "global");
}

/**
 * Write a canonical drop file atomically (tmp + rename).
 * Used by CLI hook adapters to guarantee zero half-read files.
 */
export function writeAtomicHookDropFile(
  dropDir: string,
  raw: Record<string, unknown>,
): string {
  const sanitized = {
    ...raw,
    userPrompt:
      typeof raw.userPrompt === 'string'
        ? raw.userPrompt.slice(0, 4096)
        : undefined,
  };
  const envelope = canonicalHookEnvelopeSchema.parse(sanitized);
  fs.mkdirSync(dropDir, { recursive: true, mode: 0o700 });

  const safeEvent = (envelope.event ?? "status").replace(/[^a-zA-Z0-9_-]/g, "") || "event";
  const safeSession = envelope.sessionId.replace(/[^a-zA-Z0-9_-]/g, "") || "session";
  const baseName = `${safeSession}--${envelope.timestamp}-${safeEvent}.json`;

  const finalPath = path.join(dropDir, baseName);
  const tempPath = path.join(dropDir, `.${baseName}.${process.pid}.${randomUUID()}.tmp`);

  fs.writeFileSync(tempPath, JSON.stringify(envelope), {
    mode: 0o600,
    encoding: "utf8",
  });

  try {
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    // Windows fallback: if rename fails with EPERM/EEXIST, unlink then copy
    if (process.platform === "win32") {
      try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.renameSync(tempPath, finalPath);
      } catch {
        try { fs.unlinkSync(tempPath); } catch {}
        throw err;
      }
    } else {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  return finalPath;
}

export interface AgentHookDropBoxOptions {
  dropDir?: string;
  onIngest?: (envelope: CanonicalHookEnvelope) => void;
  onError?: (error: unknown, filePath: string) => void;
}

export class AgentHookDropBoxWatcher {
  readonly #dropDir: string;
  readonly #onIngest?: (envelope: CanonicalHookEnvelope) => void;
  readonly #onError?: (error: unknown, filePath: string) => void;
  #watcher: fs.FSWatcher | null = null;
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;
  readonly #taskId = `agent-hook-dropbox:${randomUUID()}`;
  readonly #controller = new AbortController();
  #flight: Promise<number> | null = null;

  constructor(options: AgentHookDropBoxOptions = {}) {
    this.#dropDir = options.dropDir || resolveDefaultDropBoxDir();
    this.#onIngest = options.onIngest;
    this.#onError = options.onError;
  }

  get dropDir(): string {
    return this.#dropDir;
  }

  start(): void {
    if (this.#disposed) return;
    fs.mkdirSync(this.#dropDir, { recursive: true, mode: 0o700 });

    // Initial drain
    this.#requestDrain();

    // Watch for new drop files
    try {
      this.#watcher = fs.watch(this.#dropDir, (_eventType, filename) => {
        if (!filename || filename.startsWith(".") || !filename.endsWith(".json")) {
          return;
        }
        this.#scheduleDrain();
      });
      // A subscrição do kernel (FSEvents/kqueue) não é instantânea: um drop
      // escrito entre o drain inicial e o watcher ficar armado não gera evento
      // e só apareceria no próximo. Uma varredura extra fecha essa janela.
      this.#scheduleDrain();
    } catch (err) {
      console.warn("[hook-drop-box] failed to watch directory, falling back to polling:", err);
      this.#pollingTimer = setInterval(() => {
        this.#requestDrain();
      }, 1000);
    }
  }

  #requestDrain(): void {
    void this.drain().catch((error) => {
      if (!this.#disposed) this.#onError?.(error, this.#dropDir);
    });
  }

  #scheduleDrain(): void {
    if (this.#disposed || this.#drainTimer) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      this.#requestDrain();
    }, 50);
  }

  drain(): Promise<number> {
    if (this.#disposed) return Promise.resolve(0);
    if (this.#flight) return this.#flight;
    let processedCount = 0;
    const work = runPeriodicTask(this.#taskId, async (context) => {
      processedCount = await this.#drain(context);
    }, { signal: this.#controller.signal, cadenceMs: 1_000 });
    const flight = work.then(() => processedCount);
    this.#flight = flight;
    void flight.then(() => { if (this.#flight === flight) this.#flight = null; },
      () => { if (this.#flight === flight) this.#flight = null; });
    return flight;
  }

  async #drain(context: PeriodicTaskContext): Promise<number> {
    const MAX_DRAIN_BATCH = 100;
    const batch: string[] = [];
    let total = 0;
    let directory: Awaited<ReturnType<typeof fsp.opendir>>;
    try { directory = await fsp.opendir(this.#dropDir, { bufferSize: 32 }); }
    catch { return 0; }
    try {
      for (;;) {
        await context.checkpoint();
        const entry = await context.wait(directory.read());
        if (!entry) break;
        if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
        total++;
        // Keep the earliest lexical batch with bounded memory, matching the
        // previous sort order without materializing the whole directory.
        batch.push(entry.name);
        batch.sort();
        if (batch.length > MAX_DRAIN_BATCH) batch.pop();
      }
    } finally { await directory.close(); }
    let processedCount = 0;

    for (const filename of batch) {
      await context.checkpoint();
      if (this.#disposed) break;
      const filePath = path.join(this.#dropDir, filename);
      let identity: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
      const removeCurrentFile = async () => {
        if (!identity || this.#disposed) return;
        const current = await fsp.lstat(filePath).catch(() => null);
        if (current && current.dev === identity.dev && current.ino === identity.ino &&
          current.size === identity.size && current.mtimeMs === identity.mtimeMs) await fsp.unlink(filePath).catch(() => undefined);
      };
      try {
        const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let rawContent: string;
        try {
          context.assertCurrent();
          identity = await context.wait(handle.stat());
          if (!identity.isFile() || identity.nlink !== 1 || identity.size > 65_536) throw new Error('invalid hook drop file');
          const buffer = Buffer.alloc(identity.size + 1);
          const { bytesRead } = await context.wait(handle.read(buffer, 0, buffer.length, 0));
          if (bytesRead > identity.size) throw new Error('hook drop file changed');
          rawContent = buffer.subarray(0, bytesRead).toString('utf8');
          const current = await context.wait(fsp.lstat(filePath));
          if (current.dev !== identity.dev || current.ino !== identity.ino || current.mtimeMs !== identity.mtimeMs ||
            current.size !== identity.size) continue;
        } finally { await handle.close(); }
        context.assertCurrent();
        if (this.#disposed) break;
        const json = JSON.parse(rawContent) as Record<string, unknown>;

        // Handle raw Claude / agent hook payloads
        if (json.hook_event_name || (typeof json.session_id === "string" && !json.sessionId)) {
          const sid =
            (typeof json.sessionId === "string" && json.sessionId) ||
            (typeof json.session_id === "string" && json.session_id) ||
            (filename.includes("--") ? filename.split("--")[0] : "unknown-pane");
          ingestAgentHookStatus(sid, json, { pathname: "/hook/claude" });
          processedCount++;
          try {
            await removeCurrentFile();
          } catch {}
          continue;
        }

        const sid =
          (typeof json.sessionId === "string" && json.sessionId) ||
          (filename.includes("--") ? filename.split("--")[0] : "");
        if (!json.sessionId && sid) {
          json.sessionId = sid;
        }
        if (typeof json.timestamp !== "number") {
          json.timestamp = Date.now();
        }

        const envelope = canonicalHookEnvelopeSchema.parse(json);

        const mappedState = mapCanonicalStatusToAgentState(
          envelope.state ?? envelope.status,
        );
        const payload = {
          state: mappedState,
          prompt: envelope.userPrompt ?? envelope.title ?? "",
          agentType: envelope.agentType,
          providerSession: envelope.nativeSessionId
            ? {
                key: "session_id" as const,
                id: envelope.nativeSessionId,
                transcriptPath: envelope.transcriptPath,
              }
            : undefined,
        };

        // Ingest into production hook state
        ingestAgentHookStatus(envelope.sessionId, payload);

        this.#onIngest?.(envelope);
        processedCount++;

        // Clean up consumed drop file
        await removeCurrentFile();
      } catch (err) {
        context.assertCurrent();
        this.#onError?.(err, filePath);
        // On parse/validation error, delete malformed file so it does not loop
        try {
          await removeCurrentFile();
        } catch {}
      }
    }

    if (total > MAX_DRAIN_BATCH) {
      this.#scheduleDrain();
    }

    return processedCount;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#controller.abort(new Error('hook dropbox disposed'));
    if (this.#drainTimer) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    if (this.#pollingTimer) {
      clearInterval(this.#pollingTimer);
      this.#pollingTimer = null;
    }
    if (this.#watcher) {
      try {
        this.#watcher.close();
      } catch {}
      this.#watcher = null;
    }
    await stopPeriodicTask(this.#taskId);
    await this.#flight?.catch(() => undefined);
  }
}
