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
  .strict();

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
  #disposed = false;

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
    this.drain();

    // Watch for new drop files
    try {
      this.#watcher = fs.watch(this.#dropDir, (_eventType, filename) => {
        if (!filename || filename.startsWith(".") || !filename.endsWith(".json")) {
          return;
        }
        this.#scheduleDrain();
      });
    } catch (err) {
      console.warn("[hook-drop-box] failed to watch directory, falling back to polling:", err);
    }
  }

  #scheduleDrain(): void {
    if (this.#drainTimer) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      this.drain();
    }, 50);
  }

  drain(): number {
    if (this.#disposed || !fs.existsSync(this.#dropDir)) return 0;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.#dropDir);
    } catch {
      return 0;
    }

    const jsonFiles = entries
      .filter((f) => !f.startsWith(".") && f.endsWith(".json"))
      .sort();

    const MAX_DRAIN_BATCH = 100;
    const batch = jsonFiles.slice(0, MAX_DRAIN_BATCH);
    let processedCount = 0;

    for (const filename of batch) {
      const filePath = path.join(this.#dropDir, filename);
      try {
        const rawContent = fs.readFileSync(filePath, "utf8");
        const json = JSON.parse(rawContent);
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
                sessionId: envelope.nativeSessionId,
                configDir: envelope.configDir,
                transcriptPath: envelope.transcriptPath,
                resumeCommand: envelope.resumeCommand,
              }
            : undefined,
        };

        // Ingest into production hook state
        ingestAgentHookStatus(envelope.sessionId, payload);

        this.#onIngest?.(envelope);
        processedCount++;

        // Clean up consumed drop file
        fs.unlinkSync(filePath);
      } catch (err) {
        this.#onError?.(err, filePath);
        // On parse/validation error, delete malformed file so it does not loop
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }

    if (jsonFiles.length > MAX_DRAIN_BATCH) {
      this.#scheduleDrain();
    }

    return processedCount;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#drainTimer) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    if (this.#watcher) {
      try {
        this.#watcher.close();
      } catch {}
      this.#watcher = null;
    }
  }
}
