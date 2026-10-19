import { describe, expect, it, vi } from "vitest";

import {
  DARWIN_PTY_SMOKE_KILL_TIMEOUT_MS,
  DARWIN_PTY_SMOKE_TERM_TIMEOUT_MS,
  DARWIN_PTY_SMOKE_TIMEOUT_MS,
  proveDarwinPtyPipelineForSmoke,
} from "./darwin-pty-smoke";
import {
  DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
  DARWIN_PTY_PROVIDER_PROBE_MODE,
  DARWIN_PTY_PROVIDER_PROBE_RECEIPT,
} from "./darwin-pty-supervisor";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnSpec,
} from "./pty-host-core";
import type { PtyProcessTreeTerminationProof } from "./pty-descendant-termination";
import type { DarwinTrustedExecutableSeal } from "./trusted-native-cli-binary";

const sealedSmokeProvider: DarwinTrustedExecutableSeal = Object.freeze({
  platform: "darwin",
  executablePath:
    "/Applications/NexusIDE.app/Contents/Resources/nexus-pty-supervisor",
  identifier: "nexus-pty-supervisor",
  teamIdentifier: "35P5XL3JN6",
  cdHash: "1111111111111111111111111111111111111111",
  sha256: "2222222222222222222222222222222222222222222222222222222222222222",
});

function completeProof(): PtyProcessTreeTerminationProof {
  return {
    ok: true,
    rootExited: true,
    descendantsExited: true,
  };
}

function fakeHandle(overrides: Partial<PtyProcHandle> = {}): PtyProcHandle {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminate: vi.fn(async () => completeProof()),
    ...overrides,
  };
}

describe("Darwin packaged PTY smoke proof", () => {
  it("spawns the packaged helper through the authenticated production path", async () => {
    const resolveProviderSeal = vi.fn(() => sealedSmokeProvider);
    const spawn = vi.fn((_spec: PtySpawnSpec, handlers: PtySessionHandlers) => {
      queueMicrotask(() => {
        handlers.onData(`${DARWIN_PTY_PROVIDER_PROBE_RECEIPT}\r\n`);
        handlers.onExit(0);
      });
      return fakeHandle();
    });
    const host: PtyHost = { spawn };

    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
        cwd: "/tmp/nexus-smoke",
        environment: { PATH: "/usr/bin:/bin" },
        resolveProviderSeal,
      }),
    ).resolves.toBe(true);
    expect(resolveProviderSeal).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        file: sealedSmokeProvider.executablePath,
        args: [DARWIN_PTY_PROVIDER_PROBE_MODE],
        cwd: "/tmp/nexus-smoke",
        env: expect.objectContaining({ TERM: "xterm-256color" }),
        darwinExecutableSeal: sealedSmokeProvider,
        darwinTrustProfile: DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
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
        resolveProviderSeal: () => sealedSmokeProvider,
      }),
    ).rejects.toThrow(/exited 76/);
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "linux",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a zero exit that lacks the authenticated provider receipt", async () => {
    const host: PtyHost = {
      spawn: (_spec, handlers) => {
        queueMicrotask(() => handlers.onExit(0));
        return fakeHandle();
      },
    };
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
        resolveProviderSeal: () => sealedSmokeProvider,
      }),
    ).rejects.toThrow(/exited 0/);
  });

  it("retries a clean exit with no output and still demands the receipt", async () => {
    // Campo 19/10: candidato 0.76.313 sob carga — macOS descartou a saída não
    // lida do PTY e o smoke caiu com "exited 0 signal=0" sem output.
    let calls = 0;
    const spawn = vi.fn((_spec: PtySpawnSpec, handlers: PtySessionHandlers) => {
      calls += 1;
      const lucky = calls === 2;
      queueMicrotask(() => {
        if (lucky) handlers.onData(`${DARWIN_PTY_PROVIDER_PROBE_RECEIPT}\r\n`);
        handlers.onExit(0, 0);
      });
      return fakeHandle();
    });
    await expect(
      proveDarwinPtyPipelineForSmoke({ spawn }, {
        platform: "darwin",
        resolveProviderSeal: () => sealedSmokeProvider,
      }),
    ).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("never retries output without the receipt, nonzero exits or signals", async () => {
    for (const [data, code, signal] of [["intruso\r\n", 0, 0], ["", 76, 0], ["", 0, 9]] as const) {
      const spawn = vi.fn((_spec: PtySpawnSpec, handlers: PtySessionHandlers) => {
        queueMicrotask(() => {
          if (data) handlers.onData(data);
          handlers.onExit(code, signal);
        });
        return fakeHandle();
      });
      await expect(
        proveDarwinPtyPipelineForSmoke({ spawn }, {
          platform: "darwin",
          resolveProviderSeal: () => sealedSmokeProvider,
        }),
      ).rejects.toThrow(/exited/);
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });

  it("awaits physical tree proof after timeout and never raw-kills", async () => {
    let resolveTermination!: (proof: PtyProcessTreeTerminationProof) => void;
    const termination = new Promise<PtyProcessTreeTerminationProof>(
      (resolve) => {
        resolveTermination = resolve;
      },
    );
    let handlers!: PtySessionHandlers;
    const handle = fakeHandle({
      terminate: vi.fn(() => termination),
    });
    const host: PtyHost = {
      spawn: (_spec, nextHandlers) => {
        handlers = nextHandlers;
        return handle;
      },
    };
    const smoke = proveDarwinPtyPipelineForSmoke(host, {
      platform: "darwin",
      timeoutMs: 5,
      resolveProviderSeal: () => sealedSmokeProvider,
    });
    let settled = false;
    void smoke.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => {
      expect(handle.terminate).toHaveBeenCalledWith({
        termTimeoutMs: DARWIN_PTY_SMOKE_TERM_TIMEOUT_MS,
        killTimeoutMs: DARWIN_PTY_SMOKE_KILL_TIMEOUT_MS,
      });
    });
    handlers.onExit(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveTermination(completeProof());
    await expect(smoke).rejects.toThrow(/timed out/);
    expect(handle.kill).not.toHaveBeenCalled();
    expect(DARWIN_PTY_SMOKE_TIMEOUT_MS).toBe(10_000);
  });

  it("reports timeout cleanup as unproven when tree proof is incomplete", async () => {
    const handle = fakeHandle({
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: true,
        descendantsExited: false,
        error: "descendant inventory incomplete",
      })),
    });
    const host: PtyHost = { spawn: () => handle };
    await expect(
      proveDarwinPtyPipelineForSmoke(host, {
        platform: "darwin",
        timeoutMs: 5,
        resolveProviderSeal: () => sealedSmokeProvider,
      }),
    ).rejects.toThrow(/physical cleanup was not proven.*inventory incomplete/i);
    expect(handle.kill).not.toHaveBeenCalled();
  });
});
