import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { ProjectExecutionScope } from "../../shared/types";
import { shutdownPtyRuntimeWithProof } from "../app-shutdown";
import type { PtyProcessTreeTerminationProof } from "./pty-descendant-termination";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
} from "./pty-host-core";
import {
  __resetPtyShutdownLifecycleForTests,
  getSessionState,
  killSessionsFor,
  orchWriteSession,
  setPtyHost,
  spawnSession,
  terminateAllSessions,
} from "./pty-manager";

afterEach(() => {
  __resetPtyShutdownLifecycleForTests();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface ControlledSession {
  readonly handlers: PtySessionHandlers;
  readonly terminate: ReturnType<typeof vi.fn>;
  readonly terminationAttempts: Deferred<PtyProcessTreeTerminationProof>[];
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function controlledHost(): {
  readonly host: PtyHost;
  readonly sessions: Map<string, ControlledSession>;
} {
  const sessions = new Map<string, ControlledSession>();
  return {
    sessions,
    host: {
      spawn(spec, handlers) {
        const terminationAttempts: Deferred<PtyProcessTreeTerminationProof>[] =
          [];
        const terminate = vi.fn(() => {
          const attempt = deferred<PtyProcessTreeTerminationProof>();
          terminationAttempts.push(attempt);
          return attempt.promise;
        });
        const proc: PtyProcHandle = {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate,
        };
        sessions.set(spec.sessionId, {
          handlers,
          terminate,
          terminationAttempts,
        });
        return proc;
      },
    },
  };
}

function owner(): WebContents {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

function shellAuthority(): {
  scope: ProjectExecutionScope;
  cwd: string;
  shell: string;
} {
  const cwd = fs.realpathSync(process.cwd());
  return {
    cwd,
    shell: "/bin/zsh",
    scope: {
      version: 1,
      installationId: "installation-shutdown-test",
      projectId: "project-shutdown-test",
      checkoutId: "checkout-shutdown-test",
      rootRealPath: cwd,
      identitySource: "provisional",
    },
  };
}

function spawnDirectShell(sessionOwner = owner()): string {
  return spawnSession(
    sessionOwner,
    { kind: "shell", cols: 80, rows: 24 },
    shellAuthority(),
  ).sessionId;
}

const completeProof: PtyProcessTreeTerminationProof = {
  ok: true,
  rootExited: true,
  descendantsExited: true,
};

describe("terminateAllSessions", () => {
  it("blocks a queued spawn between inventory proof and host shutdown", async () => {
    const controlled = controlledHost();
    setPtyHost(controlled.host);
    const sessionId = spawnDirectShell();
    const physical = controlled.sessions.get(sessionId)!;
    const termination = terminateAllSessions({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    const shutdownPtyHost = vi.fn();

    // Register this continuation first so it deterministically runs after the
    // result resolves but before shutdownPtyRuntimeWithProof resumes and kills
    // the host.
    const queuedSpawn = termination.then(() => {
      expect(shutdownPtyHost).not.toHaveBeenCalled();
      expect(() => spawnDirectShell()).toThrow(/shutdown is in progress/i);
    });
    const appShutdown = shutdownPtyRuntimeWithProof({
      terminateAllSessions: () => termination,
      shutdownPtyHost,
    });

    physical.handlers.onExit(0, 15);
    physical.terminationAttempts[0].resolve(completeProof);
    await queuedSpawn;
    await expect(appShutdown).resolves.toMatchObject({ ok: true });
    expect(shutdownPtyHost).toHaveBeenCalledOnce();
  });

  it("keeps WebContents teardown in the shutdown inventory until physical proof", async () => {
    const controlled = controlledHost();
    setPtyHost(controlled.host);
    const renderer = owner();
    const sessionId = spawnDirectShell(renderer);
    const physical = controlled.sessions.get(sessionId)!;

    // Renderer destruction asks for termination first; it must not erase the
    // identity that the immediately-following app shutdown needs to await.
    killSessionsFor(renderer);
    expect(physical.terminate).toHaveBeenCalledOnce();
    expect(getSessionState(sessionId)).not.toBeNull();

    const shutdown = terminateAllSessions({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    expect(physical.terminate).toHaveBeenCalledOnce();
    physical.handlers.onExit(0, 15);
    physical.terminationAttempts[0].resolve(completeProof);

    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [sessionId],
      terminatedSessionIds: [sessionId],
      failedSessionIds: [],
    });
    expect(getSessionState(sessionId)).toBeNull();
  });

  it("retains a natural-exit identity when shutdown arrives one turn later", async () => {
    const controlled = controlledHost();
    setPtyHost(controlled.host);
    const sessionId = spawnDirectShell();
    const physical = controlled.sessions.get(sessionId)!;

    // The root callback is ordered just before the quit request. Main must
    // retain the exact session and query the host's stable descendant receipt.
    physical.handlers.onExit(0);
    expect(physical.terminate).toHaveBeenCalledOnce();
    expect(getSessionState(sessionId)).not.toBeNull();

    const shutdown = terminateAllSessions({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    expect(physical.terminate).toHaveBeenCalledOnce();
    physical.terminationAttempts[0].resolve(completeProof);

    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [sessionId],
      terminatedSessionIds: [sessionId],
      failedSessionIds: [],
    });
    expect(getSessionState(sessionId)).toBeNull();
  });

  it("terminates concurrent direct sessions and waits for root plus descendants", async () => {
    const controlled = controlledHost();
    setPtyHost(controlled.host);
    const firstId = spawnDirectShell();
    const secondId = spawnDirectShell();

    const shutdown = terminateAllSessions({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    expect(terminateAllSessions()).toBe(shutdown);

    const first = controlled.sessions.get(firstId)!;
    const second = controlled.sessions.get(secondId)!;
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(() => spawnDirectShell()).toThrow(/shutdown is in progress/i);

    // Descendant proof alone is insufficient: both roots remain registered.
    first.terminationAttempts[0].resolve(completeProof);
    second.terminationAttempts[0].resolve(completeProof);
    await Promise.resolve();
    expect(getSessionState(firstId)).not.toBeNull();
    expect(getSessionState(secondId)).not.toBeNull();

    first.handlers.onExit(0, 15);
    second.handlers.onExit(0, 15);
    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [firstId, secondId],
      terminatedSessionIds: [firstId, secondId],
      failedSessionIds: [],
    });
    expect(getSessionState(firstId)).toBeNull();
    expect(getSessionState(secondId)).toBeNull();

    // Even a queued continuation that runs after the result but before
    // shutdownPtyHost must not create a process outside the proven inventory.
    await Promise.resolve();
    expect(() => spawnDirectShell()).toThrow(/shutdown is in progress/i);
  });

  it("completes shutdown when the host proves the root already exited", async () => {
    const controlled = controlledHost();
    setPtyHost(controlled.host);
    const stubbornId = spawnDirectShell();
    const stubborn = controlled.sessions.get(stubbornId)!;

    const firstAttempt = terminateAllSessions({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    stubborn.handlers.onExit(0, 15);
    stubborn.terminationAttempts[0].resolve({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: "descendant still alive",
    });

    await expect(firstAttempt).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [stubbornId],
      terminatedSessionIds: [stubbornId],
      failedSessionIds: [],
    });
    expect(getSessionState(stubbornId)).toBeNull();
    expect(orchWriteSession(stubbornId, "late command\r")).toBe(false);

    // Root exit plus utility-host destruction is the bounded shutdown receipt
    // introduced by b9572c43. Admission stays permanently sealed so no new
    // process can enter between this result and host destruction.
    expect(() => spawnDirectShell()).toThrow(/shutdown is in progress/i);
  });
});
