import { createRequire } from 'node:module';
import type { Worker as NodeWorker } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import type { ProjectExecutionScope } from '../../shared/types';
import { resolveRootForScope } from './workspace-path';
import { LSP_WORKER_SOURCE } from './lsp-worker-source';

// Forge emits the Electron main process as CommonJS. In that bundle,
// `import.meta.url` is erased to `{}.url`; __filename remains an absolute,
// valid createRequire base in both development and packaged runtimes.
const requireForLsp = createRequire(__filename);

export const LSP_LIMITS = Object.freeze({
  defaultResults: 50,
  maxResults: 100,
  maxProjectFiles: 2_000,
  maxReadFiles: 5_000,
  maxDirectories: 2_000,
  maxDirectoryEntries: 10_000,
  maxFileBytes: 1_048_576,
  maxConfigBytes: 65_536,
  maxTotalBytes: 32 * 1024 * 1024,
  maxOutputBytes: 128 * 1024,
  workerBudgetMs: 8_000,
  parentTimeoutMs: 8_500,
  maxConcurrentWorkers: 2,
});

const activeScopes = new Set<string>();
let activeWorkerCount = 0;

interface LspBaseQuery {
  readonly path: string;
  readonly maxResults?: number;
}

export type LspQuery =
  | (LspBaseQuery & { readonly kind: 'symbols' | 'diagnostics' })
  | (LspBaseQuery & {
      readonly kind: 'definition' | 'references';
      readonly line: number;
      readonly column: number;
    });

export interface LspQueryResult {
  readonly language: 'typescript';
  readonly path: string;
  readonly truncated: boolean;
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly budget: {
    readonly filesRead: number;
    readonly bytesRead: number;
    readonly directoriesRead: number;
    readonly elapsedMs: number;
  };
}

interface WorkerLike {
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  removeListener(
    event: string | symbol,
    // Mirrors EventEmitter/Worker's listener contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): this;
  terminate(): Promise<number>;
}

interface WorkerEnvelope {
  readonly ok: boolean;
  readonly result?: LspQueryResult;
  readonly error?: string;
}

function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as WorkerEnvelope).ok === 'boolean',
  );
}

function settleWorker(
  worker: WorkerLike,
  timeoutMs: number,
): Promise<LspQueryResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (
      action: () => void,
      terminate = true,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate().catch(() => undefined);
      action();
    };
    const onMessage = (message: unknown): void => {
      if (!isWorkerEnvelope(message)) {
        finish(() => reject(new Error('LSP worker returned an invalid response')));
        return;
      }
      if (!message.ok || !message.result) {
        finish(() => reject(new Error(message.error || 'LSP worker failed')));
        return;
      }
      const result = message.result;
      finish(() => resolve(result));
    };
    const onError = (error: Error): void => {
      finish(() => reject(new Error(`LSP worker failed: ${error.message}`)));
    };
    const onExit = (code: number): void => {
      finish(
        () => reject(new Error(`LSP worker exited before responding (${code})`)),
        false,
      );
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    timer = setTimeout(() => {
      finish(() => reject(new Error('LSP request exceeded its hard time limit')));
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Test seam for proving the hard timeout physically terminates a hung worker.
 * Production always constructs the worker in runScopedLspQuery below.
 */
export function __settleLspWorkerForTests(
  worker: WorkerLike,
  timeoutMs: number,
): Promise<LspQueryResult> {
  return settleWorker(worker, timeoutMs);
}

/**
 * Main-owned, no-watcher TypeScript service. A fresh worker per request makes
 * project authority non-shareable and lets main enforce a true wall-clock
 * bound by terminating the worker rather than merely racing a Promise.
 */
export async function runScopedLspQuery(
  scope: Readonly<ProjectExecutionScope>,
  query: LspQuery,
): Promise<LspQueryResult> {
  const rootRealPath = resolveRootForScope(scope);
  if (
    typeof query.path !== 'string' ||
    query.path.length === 0 ||
    query.path.length > 4_096 ||
    query.path.includes('\0')
  ) {
    throw new Error('LSP path is invalid');
  }
  if (
    query.maxResults !== undefined &&
    (!Number.isInteger(query.maxResults) ||
      query.maxResults < 1 ||
      query.maxResults > LSP_LIMITS.maxResults)
  ) {
    throw new Error(`LSP maxResults must be between 1 and ${LSP_LIMITS.maxResults}`);
  }
  if (
    (query.kind === 'definition' || query.kind === 'references') &&
    (!Number.isInteger(query.line) ||
      query.line < 1 ||
      !Number.isInteger(query.column) ||
      query.column < 1)
  ) {
    throw new Error('LSP line and column must be positive integers');
  }
  const scopeKey = [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    rootRealPath,
  ].join('\0');
  if (activeScopes.has(scopeKey)) {
    throw new Error('an LSP request is already active for this execution scope');
  }
  if (activeWorkerCount >= LSP_LIMITS.maxConcurrentWorkers) {
    throw new Error('LSP worker capacity is busy; retry after the active request');
  }

  activeScopes.add(scopeKey);
  activeWorkerCount += 1;
  try {
    const typescriptPath = requireForLsp.resolve('typescript');
    const worker: NodeWorker = new Worker(LSP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        rootRealPath,
        typescriptPath,
        query,
        limits: LSP_LIMITS,
      },
    });
    return await settleWorker(worker, LSP_LIMITS.parentTimeoutMs);
  } finally {
    activeScopes.delete(scopeKey);
    activeWorkerCount = Math.max(0, activeWorkerCount - 1);
  }
}
