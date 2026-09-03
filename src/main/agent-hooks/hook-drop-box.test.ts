import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  writeAtomicHookDropFile,
  AgentHookDropBoxWatcher,
  type CanonicalHookEnvelope,
} from "./hook-drop-box";

describe("hook-drop-box", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drop-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
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

  it("drains drop files, invokes callback, and cleans up files", () => {
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

    const count = watcher.drain();
    expect(count).toBe(1);
    expect(ingested.length).toBe(1);
    expect(ingested[0].sessionId).toBe("session-456");
    expect(ingested[0].status).toBe("idle");

    // File should have been deleted after consumption
    const remaining = fs.readdirSync(tempDir);
    expect(remaining.length).toBe(0);

    watcher.dispose();
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

    // Wait for fs.watch and debounce
    await new Promise((r) => setTimeout(r, 120));

    expect(ingested.length).toBe(1);
    expect(ingested[0].sessionId).toBe("session-async");
    expect(ingested[0].status).toBe("needs-input");

    watcher.dispose();
  });
});
