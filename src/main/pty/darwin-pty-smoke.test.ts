import { describe, expect, it, vi } from "vitest";

import {
  DARWIN_PTY_SMOKE_TIMEOUT_MS,
  proveDarwinPtyPipelineForSmoke,
} from "./darwin-pty-smoke";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnSpec,
} from "./pty-host-core";

function fakeHandle(): PtyProcHandle {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminate: vi.fn(async () => ({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    })),
  };
}

describe("Darwin packaged PTY smoke proof", () => {
  it("spawns an absolute provider through the production host and requires zero", async () => {
    const spawn = vi.fn(
      (_spec: PtySpawnSpec, handlers: PtySessionHandlers) => {
        queueMicrotask(() => handlers.onExit(0));
        return fakeHandle();
      },
    );
    const host: PtyHost = { spawn };

    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
        cwd: "/tmp/nexus-smoke",
        environment: { PATH: "/usr/bin:/bin" },
      }),
    ).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "/usr/bin/true",
        args: [],
        cwd: "/tmp/nexus-smoke",
        env: expect.objectContaining({ TERM: "xterm-256color" }),
      }),
      expect.any(Object),
    );
  });

  it("rejects nonzero exits and skips other platforms", async () => {
    const host: PtyHost = {
      spawn: (_spec, handlers) => {
        queueMicrotask(() => handlers.onExit(76));
        return fakeHandle();
      },
    };
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
      }),
    ).rejects.toThrow(/exited 76/);
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "linux",
      }),
    ).resolves.toBe(false);
  });

  it("kills a hung proof at the bounded timeout", async () => {
    const handle = fakeHandle();
    const host: PtyHost = { spawn: () => handle };
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/);
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");
    expect(DARWIN_PTY_SMOKE_TIMEOUT_MS).toBe(10_000);
  });
});
