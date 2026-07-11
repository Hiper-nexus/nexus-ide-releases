import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ortDeps = vi.hoisted(() => {
  type Session = {
    inputNames: string[];
    outputNames: string[];
    run: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  const sessions: Session[] = [];
  const firstMelRun = {
    promise: Promise.resolve<unknown>({ output: { data: new Float32Array(32 * 76) } }),
    resolve: (_value: unknown): void => {},
  };
  return {
    sessions,
    firstMelRun,
    reset() {
      sessions.length = 0;
    },
  };
});

vi.mock('node:fs', () => ({
  default: {
    statSync: vi.fn(() => {
      throw new Error('missing optional model');
    }),
    readFileSync: vi.fn(),
  },
}));

vi.mock('./wake-models', () => ({
  MELSPEC_ONNX_B64: 'AA==',
  EMBEDDING_ONNX_B64: 'AA==',
  HEY_JARVIS_ONNX_B64: 'AA==',
}));

vi.mock('onnxruntime-node', () => ({
  Tensor: class {},
  InferenceSession: {
    create: vi.fn(async () => {
      const index = ortDeps.sessions.length;
      const session = {
        inputNames: ['input'],
        outputNames: ['output'],
        run: vi.fn(async () => {
          if (index === 0 && session.run.mock.calls.length === 1) {
            return ortDeps.firstMelRun.promise;
          }
          if (index === 0) {
            return { output: { data: new Float32Array(32 * 76) } };
          }
          if (index === 1) {
            return { output: { data: new Float32Array(96) } };
          }
          return { output: { data: new Float32Array([0]) } };
        }),
        release: vi.fn(async () => undefined),
      };
      ortDeps.sessions.push(session);
      return session;
    }),
  },
}));

import { WakeEngine } from './wake-engine';

describe('WakeEngine lifecycle', () => {
  beforeEach(() => {
    ortDeps.reset();
    const gate = deferred<unknown>();
    ortDeps.firstMelRun.promise = gate.promise;
    ortDeps.firstMelRun.resolve = gate.resolve;
  });

  it('does not dereference released fields when disposed during async initialization', async () => {
    const engine = new WakeEngine(vi.fn());
    const initialization = engine.init();

    await vi.waitFor(() => expect(ortDeps.sessions).toHaveLength(3));
    await vi.waitFor(() => expect(ortDeps.sessions[0]!.run).toHaveBeenCalledTimes(1));

    const disposal = engine.dispose();
    ortDeps.firstMelRun.resolve({ output: { data: new Float32Array(32 * 76) } });

    await expect(initialization).resolves.toBeUndefined();
    await expect(disposal).resolves.toBeUndefined();
    expect(ortDeps.sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true);
  });
});
