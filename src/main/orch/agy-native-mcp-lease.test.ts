import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireAgyNativeMcpLease,
  releaseAgyNativeMcpLease,
  recoverStaleAgyNativeLeases,
} from "./agy-native-mcp-lease";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agy-lease-"));
  created.push(dir);
  return fs.realpathSync.native(dir);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

const URL = "http://127.0.0.1:9/mcp";
const TOKEN = "tok_test_abc123";

describe("agy native MCP lease", () => {
  it("injects the nexus server and restores byte-for-byte on release", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const cliDir = path.join(home, ".gemini", "antigravity-cli");
    const configPath = path.join(cliDir, "mcp_config.json");
    const original = {
      mcpServers: {
        github: { command: "npx", args: ["-y", "github-mcp"] },
      },
    };
    writeJson(configPath, original);
    const originalBytes = fs.readFileSync(configPath);

    const lease = acquireAgyNativeMcpLease(URL, TOKEN, {
      home,
      artifactRoot,
    });

    expect(lease.configPaths).toContain(configPath);
    expect(lease.realHome).toBe(home);
    expect(lease.providerStateDir).toBe(cliDir);
    expect(fs.existsSync(lease.runtimeDir)).toBe(true);

    // Injected: nexus present, other servers untouched.
    const injected = readJson(configPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect(injected.mcpServers.github).toEqual(original.mcpServers.github);
    expect(injected.mcpServers.nexus).toMatchObject({ serverUrl: URL });

    releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });

    // Byte-for-byte restore.
    expect(fs.readFileSync(configPath).equals(originalBytes)).toBe(true);
    // Runtime and session artifacts are gone; the lock is released.
    expect(fs.existsSync(lease.runtimeDir)).toBe(false);
    expect(fs.existsSync(path.join(artifactRoot, "profile.lock"))).toBe(false);
  });

  it("never writes the bearer token into the journal or backup names", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const configPath = path.join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    writeJson(configPath, { mcpServers: {} });

    acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });

    const sessionDirs = fs
      .readdirSync(artifactRoot)
      .filter((entry) => entry !== "profile.lock");
    expect(sessionDirs.length).toBeGreaterThan(0);
    for (const dirName of sessionDirs) {
      expect(dirName).not.toContain(TOKEN);
      const journalPath = path.join(artifactRoot, dirName, "journal.json");
      if (fs.existsSync(journalPath)) {
        expect(fs.readFileSync(journalPath, "utf8")).not.toContain(TOKEN);
      }
    }
    // The config DOES carry the bearer (that is the point), but the lock
    // file must not.
    const lock = fs.readFileSync(path.join(artifactRoot, "profile.lock"), "utf8");
    expect(lock).not.toContain(TOKEN);

    releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });
  });

  it("refuses a second live session on the same native profile", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const configPath = path.join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    writeJson(configPath, { mcpServers: {} });

    acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });
    try {
      expect(() =>
        acquireAgyNativeMcpLease(URL, "tok_other_session", {
          home,
          artifactRoot,
        }),
      ).toThrow(/another governed AGY session/i);
    } finally {
      releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });
    }
  });

  it("takes over a stale lock from a dead process", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const configPath = path.join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    writeJson(configPath, { mcpServers: {} });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(
      path.join(artifactRoot, "profile.lock"),
      JSON.stringify({
        pid: 999999999, // not alive
        sessionKey: "deadbeef",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const lease = acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });
    expect(lease.configPaths).toContain(configPath);
    releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });
  });

  it("preserves external edits made during the session", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const configPath = path.join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    writeJson(configPath, { mcpServers: { a: { command: "a" } } });

    acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });

    // The user adds another server while the session is live.
    const during = readJson(configPath) as {
      mcpServers: Record<string, unknown>;
    };
    during.mcpServers.userAdded = { command: "user" };
    fs.writeFileSync(configPath, JSON.stringify(during, null, 2), "utf8");

    releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });

    const after = readJson(configPath) as {
      mcpServers: Record<string, unknown>;
    };
    // nexus removed, user edit preserved, original preserved.
    expect(after.mcpServers.nexus).toBeUndefined();
    expect(after.mcpServers.userAdded).toEqual({ command: "user" });
    expect(after.mcpServers.a).toEqual({ command: "a" });
  });

  it("recovers a crashed lease at startup", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const configPath = path.join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    const original = { mcpServers: { keep: { command: "keep" } } };
    writeJson(configPath, original);
    const originalBytes = fs.readFileSync(configPath);

    const lease = acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });
    // Simulate a crash: the process dies WITHOUT releasing. Forge the journal
    // pid to a dead process so recovery claims it.
    const sessionDir = path.dirname(
      fs
        .readdirSync(artifactRoot)
        .filter((entry) => entry !== "profile.lock")
        .map((entry) => path.join(artifactRoot, entry, "journal.json"))
        .find((candidate) => fs.existsSync(candidate))!,
    );
    const journal = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "journal.json"), "utf8"),
    ) as { pid: number };
    journal.pid = 999999999;
    fs.writeFileSync(
      path.join(sessionDir, "journal.json"),
      JSON.stringify(journal, null, 2),
      "utf8",
    );
    // Also forge the lock pid so recovery removes it.
    const lockPath = path.join(artifactRoot, "profile.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
    lock.pid = 999999999;
    fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");

    const result = recoverStaleAgyNativeLeases({ home, artifactRoot });
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);

    // Config restored byte-for-byte, artifacts purged, lock gone.
    expect(fs.readFileSync(configPath).equals(originalBytes)).toBe(true);
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(lease.runtimeDir)).toBe(false);
  });

  it("preserves the journal when restore fails during release, then recovers at startup", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    const cliDir = path.join(home, ".gemini", "antigravity-cli");
    const configPath = path.join(cliDir, "mcp_config.json");
    writeJson(configPath, { mcpServers: { keep: { command: "keep" } } });

    acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot });

    // Find the session directory (the one containing journal.json).
    const sessionDir = fs
      .readdirSync(artifactRoot)
      .filter((entry) => entry !== "profile.lock")
      .map((entry) => path.join(artifactRoot, entry))
      .find((dir) => fs.existsSync(path.join(dir, "journal.json")))!;
    expect(sessionDir).toBeDefined();

    // Make the config file and its directory read-only so restoreConfig
    // cannot write back the restored content.
    fs.chmodSync(configPath, 0o400);
    fs.chmodSync(cliDir, 0o500);

    // Release: restoreConfig throws, but the journal must survive.
    releaseAgyNativeMcpLease(TOKEN, { home, artifactRoot });

    // Restore permissions for verification.
    fs.chmodSync(cliDir, 0o700);
    fs.chmodSync(configPath, 0o600);

    // The journal and backups are still on disk for startup recovery.
    expect(fs.existsSync(path.join(sessionDir, "journal.json"))).toBe(true);

    // The nexus entry (with bearer) is still in the config.
    const config = readJson(configPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.nexus).toBeDefined();

    // The lock is released (the owning process is ending).
    expect(fs.existsSync(path.join(artifactRoot, "profile.lock"))).toBe(false);

    // Forge the journal pid to a dead process and run startup recovery.
    const journal = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "journal.json"), "utf8"),
    ) as { pid: number };
    journal.pid = 999999999;
    fs.writeFileSync(
      path.join(sessionDir, "journal.json"),
      JSON.stringify(journal, null, 2),
      "utf8",
    );

    const result = recoverStaleAgyNativeLeases({ home, artifactRoot });
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);

    // Config is now restored: nexus gone, original preserved.
    const restored = readJson(configPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect(restored.mcpServers.nexus).toBeUndefined();
    expect(restored.mcpServers.keep).toEqual({ command: "keep" });
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it("throws when the profile has no mcp_config.json", () => {
    const home = tempDir();
    const artifactRoot = tempDir();
    fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), {
      recursive: true,
    });

    expect(() =>
      acquireAgyNativeMcpLease(URL, TOKEN, { home, artifactRoot }),
    ).toThrow(/no mcp_config\.json/i);
    // The lock must not linger after the failure.
    expect(fs.existsSync(path.join(artifactRoot, "profile.lock"))).toBe(false);
  });
});
