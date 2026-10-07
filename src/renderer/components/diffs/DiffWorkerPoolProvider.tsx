// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Effect Schema error → local Error,
// useTheme → html[data-theme] (nexus-light), React 18 Context.Provider, shiki-js highlighter.
import { WorkerPoolContext, useWorkerPool } from '@pierre/diffs/react';
import { WorkerPoolManager } from '@pierre/diffs/worker';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  DIFF_PREFERRED_HIGHLIGHTER,
  readDiffColorScheme,
  resolveDiffThemeName,
  type DiffColorScheme,
  type DiffThemeName,
} from '../../lib/diff-rendering';

type DiffWorkerOperation = 'create-worker' | 'get-render-options' | 'set-render-options';

export class DiffWorkerError extends Error {
  readonly operation: DiffWorkerOperation;
  readonly themeName: DiffThemeName;

  constructor({
    operation,
    themeName,
    cause,
  }: {
    operation: DiffWorkerOperation;
    themeName: DiffThemeName;
    cause: unknown;
  }) {
    super(`Diff worker operation ${operation} failed for theme ${themeName}.`, { cause });
    this.name = 'DiffWorkerError';
    this.operation = operation;
    this.themeName = themeName;
  }
}

function subscribeColorScheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

/** Segue `applyUiTheme`: o realce troca de paleta quando o tema do app troca. */
export function useDiffColorScheme(): DiffColorScheme {
  return useSyncExternalStore(subscribeColorScheme, () => readDiffColorScheme(), () => 'dark');
}

export const DIFF_WORKER_IDLE_TTL_MS = 30_000;
let sharedWorkerPool:
  | {
      readonly pool: WorkerPoolManager;
      consumers: number;
      idleTimer: ReturnType<typeof setTimeout> | undefined;
    }
  | undefined;

/** Create workers after a viewer commits, then reuse them across short panel closures. */
function acquireDiffWorkerPool(themeName: DiffThemeName, poolSize: number) {
  const entry = (sharedWorkerPool ??= {
    pool: new WorkerPoolManager(
      {
        workerFactory: () => {
          try {
            return new DiffsWorker();
          } catch (cause) {
            throw new DiffWorkerError({ operation: 'create-worker', themeName, cause });
          }
        },
        poolSize,
        totalASTLRUCacheSize: 240,
      },
      {
        theme: themeName,
        preferredHighlighter: DIFF_PREFERRED_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      },
    ),
    consumers: 0,
    idleTimer: undefined,
  });
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerOperation = 'get-render-options';
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = 'set-render-options';
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

// Plain-text views do not queue a highlight task that could retry a blank first render.
function DiffWorkerReady({ children }: { children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const [readyPool, setReadyPool] = useState<WorkerPoolManager>();
  const ready = workerPool
    ? readyPool === workerPool || workerPool.isInitialized() || !workerPool.isWorkingPool()
    : typeof window === 'undefined';

  useEffect(() => {
    if (ready || !workerPool) return;

    let mounted = true;
    const finish = () => {
      if (mounted) setReadyPool(workerPool);
    };
    // Failed pools use Pierre's existing main-thread highlighter.
    void workerPool.initialize().then(finish, finish);
    return () => {
      mounted = false;
    };
  }, [ready, workerPool]);

  return ready ? (
    <>{children}</>
  ) : (
    <p role="status" className="git-scm__diff-placeholder">
      Carregando realce…
    </p>
  );
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const diffThemeName = resolveDiffThemeName(useDiffColorScheme());
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === 'undefined' ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);
  const workerPool = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        if (typeof window === 'undefined') return () => {};
        const entry = acquireDiffWorkerPool(diffThemeName, workerPoolSize);
        onStoreChange();
        return () => {
          entry.consumers -= 1;
          if (entry.consumers !== 0) return;
          entry.idleTimer = setTimeout(() => {
            entry.idleTimer = undefined;
            entry.pool.terminate();
            if (sharedWorkerPool === entry) sharedWorkerPool = undefined;
          }, DIFF_WORKER_IDLE_TTL_MS);
        };
      },
      [diffThemeName, workerPoolSize],
    ),
    () => sharedWorkerPool?.pool,
    () => undefined,
  );

  return (
    <WorkerPoolContext.Provider value={workerPool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      <DiffWorkerReady>{children}</DiffWorkerReady>
    </WorkerPoolContext.Provider>
  );
}
