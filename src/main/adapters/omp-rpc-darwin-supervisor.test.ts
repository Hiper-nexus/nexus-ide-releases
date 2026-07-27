import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  OmpRpcSession,
  type OmpChildLike,
  type OmpRpcSessionDeps,
} from './omp-rpc-service';

class ReceiptProcess implements OmpChildLike {
  private readonly emitter = new EventEmitter();
  readonly kills: NodeJS.Signals[] = [];
  readonly pid = 8123;

  constructor(
    private readonly receipt:
      | { code: number; signal?: null }
      | { code: null; signal: NodeJS.Signals },
  ) {}

  readonly stdin = { write: () => true };
  readonly stdout = {
    on: (_event: 'data', _cb: (chunk: Buffer | string) => void) => this,
  };
  readonly stderr = {
    on: (_event: 'data', _cb: (chunk: Buffer | string) => void) => this,
  };

  on(
    event: 'exit',
    cb: (
      code: number | null,
      signal?: NodeJS.Signals | number | null,
    ) => void,
  ): this;
  on(event: 'error', cb: (error: Error) => void): this;
  on(
    event: 'exit' | 'error',
    cb:
      | ((
          code: number | null,
          signal?: NodeJS.Signals | number | null,
        ) => void)
      | ((error: Error) => void),
  ): this {
    this.emitter.on(event, cb as (...args: unknown[]) => void);
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.emitter.emit(
        'exit',
        this.receipt.code,
        this.receipt.signal ?? null,
      );
    });
    return true;
  }
}

function sessionDeps(
  overrides: Partial<OmpRpcSessionDeps>,
): OmpRpcSessionDeps {
  return {
    hostTools: [],
    dispatchHostTool: async () => ({ ok: true }),
    auditAutoApproval: () => {},
    onPush: () => {},
    processInventoryIntervalMs: 30_000,
    ...overrides,
  };
}

function createSession(deps: OmpRpcSessionDeps): OmpRpcSession {
  return new OmpRpcSession(
    {
      sessionId: 'darwin-receipt',
      workspaceRoot: '/tmp',
      approvalPolicy: 'safe',
      binPath: '/usr/local/bin/omp',
    },
    deps,
  );
}

describe('OMP RPC Darwin responsibility receipt', () => {
  it('uses a normal default-helper exit as the complete native teardown proof', async () => {
    const proc = new ReceiptProcess({ code: 23 });
    const terminateProcessTree = vi.fn();
    const captureProcessTree = vi.fn();
    const session = createSession(
      sessionDeps({
        runtimePlatformForTest: 'darwin',
        defaultSpawnImplForTest: () => proc,
        terminateProcessTree,
        captureProcessTree,
      }),
    );

    await expect(session.terminate()).resolves.toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(captureProcessTree).not.toHaveBeenCalled();
  });

  it('fails closed when the native helper itself exits by signal', async () => {
    const proc = new ReceiptProcess({
      code: null,
      signal: 'SIGKILL',
    });
    const terminateProcessTree = vi.fn();
    const session = createSession(
      sessionDeps({
        runtimePlatformForTest: 'darwin',
        defaultSpawnImplForTest: () => proc,
        terminateProcessTree,
      }),
    );

    const proof = await session.terminate();
    expect(proof.ok).toBe(false);
    expect(proof.rootExited).toBe(true);
    expect(proof.descendantsExited).toBe(false);
    expect(proof.error).toMatch(/não produziu uma saída normal/i);
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it('keeps injected spawnImpl sessions on the generic inventory contract', async () => {
    const proc = new ReceiptProcess({ code: 0 });
    const terminateProcessTree = vi.fn(async () => ({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    }));
    const captureProcessTree = vi.fn(async () => null);
    const session = createSession(
      sessionDeps({
        runtimePlatformForTest: 'darwin',
        spawnImpl: () => proc,
        terminateProcessTree,
        captureProcessTree,
      }),
    );

    await expect(session.terminate()).resolves.toMatchObject({ ok: true });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(captureProcessTree).toHaveBeenCalled();
  });
});
