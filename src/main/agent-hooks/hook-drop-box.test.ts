import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeAtomicHookDropFile,
  AgentHookDropBoxWatcher,
  type CanonicalHookEnvelope,
} from "./hook-drop-box";

describe("hook-drop-box", () => {
  it("owns one async drain across concurrent requests and stops before delivery", async () => {
    const watcher = new AgentHookDropBoxWatcher({ dropDir: tempDir });
    writeAtomicHookDropFile(tempDir, { sessionId: 'held', status: 'idle', timestamp: Date.now() });
    const first = watcher.drain();
    void first.catch(() => undefined);
    expect(first).toBeInstanceOf(Promise);
    expect(watcher.drain()).toBe(first);
    await watcher.dispose();
    await first.catch(() => undefined);
  });
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drop-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it.skipIf(process.platform === 'win32')('F-887: regular-to-FIFO replacement cannot block physical drain or disposal', async () => {
    const file = writeAtomicHookDropFile(tempDir, { sessionId: 'fifo-fixture', status: 'idle', timestamp: Date.now() });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((...args) => {
      if (String(args[0]) === file) { fs.unlinkSync(file); execFileSync('/usr/bin/mkfifo', [file]); enter(); }
      return open(...args);
    });
    const onIngest = vi.fn();
    const watcher = new AgentHookDropBoxWatcher({ dropDir: tempDir, onIngest });
    const flight = watcher.drain().catch(() => undefined);
    await entered;
    let disposed = false;
    const stop = watcher.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    const beforeRescue = disposed;
    const rescue = !beforeRescue ? fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NONBLOCK) : null;
    try { await flight; await stop; } finally { if (rescue !== null) fs.closeSync(rescue); }
    expect(beforeRescue).toBe(true);
    expect(onIngest).not.toHaveBeenCalled();
  });

  it('F-887: short FD reads preserve and ingest a complete valid record', async () => {
    const file = writeAtomicHookDropFile(tempDir, { sessionId: 'short-fixture', status: 'idle', timestamp: Date.now(), body: 'A complete record must survive short reads.' });
    const open = fs.promises.open.bind(fs.promises);
    let reads = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file) {
        const read = handle.read.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads++; return read(buffer, offset, Math.min(length, 11), position);
        }) as typeof handle.read;
      }
      return handle;
    });
    const onIngest = vi.fn();
    const watcher = new AgentHookDropBoxWatcher({ dropDir: tempDir, onIngest });
    try {
      expect(await watcher.drain()).toBe(1);
      expect(onIngest).toHaveBeenCalledWith(expect.objectContaining({ body: 'A complete record must survive short reads.' }));
      expect(reads).toBeGreaterThan(1);
      expect(fs.existsSync(file)).toBe(false);
    } finally { await watcher.dispose(); }
  });

  it('F-887: a hardlink created after the initial FD stat cannot supply hook authority', async () => {
    const file = writeAtomicHookDropFile(tempDir, { sessionId: 'link-fixture', status: 'idle', timestamp: Date.now() });
    const open = fs.promises.open.bind(fs.promises);
    let linked = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(read, handle, readArgs);
          if (!linked) { linked = true; fs.linkSync(file, path.join(tempDir, '.owned-link')); }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    const onIngest = vi.fn();
    const watcher = new AgentHookDropBoxWatcher({ dropDir: tempDir, onIngest });
    try {
      expect(await watcher.drain()).toBe(0);
      expect(onIngest).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(true);
    } finally { await watcher.dispose(); }
  });

  it("writes drop file atomically and truncates user prompt to 4KB", () => {
    const hugePrompt = "A".repeat(8000);
    const envelope: CanonicalHookEnvelope = {
      sessionId: "session-123",
      status: "running",
      event: "session-start",
      timestamp: Date.now(),
      userPrompt: hugePrompt,
      nativeSessionId: "native-claude-99",
      agentType: "claude",
      configDir: "/tmp/claude-conf",
      resumeCommand: "claude --resume native-claude-99",
    };

    const writtenPath = writeAtomicHookDropFile(tempDir, envelope);
    expect(fs.existsSync(writtenPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    expect(content.sessionId).toBe("session-123");
    expect(content.nativeSessionId).toBe("native-claude-99");
    expect(content.userPrompt.length).toBe(4096);
  });

  it("drains drop files, invokes callback, and cleans up files", async () => {
    const ingested: CanonicalHookEnvelope[] = [];
    const envelope: CanonicalHookEnvelope = {
      sessionId: "session-456",
      status: "idle",
      event: "stop",
      timestamp: Date.now(),
      agentType: "claude",
    };

    writeAtomicHookDropFile(tempDir, envelope);

    const watcher = new AgentHookDropBoxWatcher({
      dropDir: tempDir,
      onIngest: (ev) => ingested.push(ev),
    });

    const count = await watcher.drain();
    expect(count).toBe(1);
    expect(ingested.length).toBe(1);
    expect(ingested[0].sessionId).toBe("session-456");
    expect(ingested[0].status).toBe("idle");

    // File should have been deleted after consumption
    const remaining = fs.readdirSync(tempDir);
    expect(remaining.length).toBe(0);

    await watcher.dispose();
  });

  it("watches directory and drains new files as they arrive", async () => {
    const ingested: CanonicalHookEnvelope[] = [];
    const watcher = new AgentHookDropBoxWatcher({
      dropDir: tempDir,
      onIngest: (ev) => ingested.push(ev),
    });

    watcher.start();

    writeAtomicHookDropFile(tempDir, {
      sessionId: "session-async",
      status: "needs-input",
      event: "notification",
      timestamp: Date.now(),
    });

    // Espera determinística: fs.watch arma de forma assíncrona no macOS, e um
    // sleep fixo de 120 ms perdia a corrida (flake 1 em 3 rodadas isoladas).
    const deadline = Date.now() + 2_000;
    while (ingested.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(ingested.length).toBe(1);
    expect(ingested[0].sessionId).toBe("session-async");
    expect(ingested[0].status).toBe("needs-input");

    await watcher.dispose();
  });
});
