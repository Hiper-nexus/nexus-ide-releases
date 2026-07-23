/**
 * Small bounded-operation primitive for SSH callbacks.
 *
 * Nexus-authored after reviewing Orca's operation lifecycle patterns at
 * 143c36e. It deliberately does not retry: an exec or write timeout can mean
 * the remote effect happened even though its acknowledgement was lost.
 */

export type SshTransportErrorCode =
  | 'not_connected'
  | 'connection_lost'
  | 'connect_timeout'
  | 'operation_failed'
  | 'operation_timeout'
  | 'operation_aborted'
  | 'stale_generation';

export class SshTransportError extends Error {
  readonly code: SshTransportErrorCode;
  readonly outcomeUnknown: boolean;

  constructor(
    code: SshTransportErrorCode,
    message: string,
    options: {
      readonly outcomeUnknown?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SshTransportError';
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export type BoundedSshOperation<T> = {
  readonly promise: Promise<T>;
  isActive(): boolean;
  setCleanup(cleanup: () => void): void;
  resolve(value: T): void;
  reject(error: unknown): void;
  cancel(error: SshTransportError): void;
};

export function createBoundedSshOperation<T>(options: {
  readonly label: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly outcomeUnknownOnTimeout: boolean;
  readonly isGenerationCurrent: () => boolean;
}): BoundedSshOperation<T> {
  let settled = false;
  let cleanup: (() => void) | null = null;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const settle = (
    kind: 'resolve' | 'reject',
    value: T | unknown,
    runCleanup: boolean,
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (runCleanup) safeCleanup(cleanup);
    cleanup = null;
    if (kind === 'resolve') resolvePromise(value as T);
    else rejectPromise(value);
  };

  const onAbort = (): void => {
    settle(
      'reject',
      new SshTransportError(
        'operation_aborted',
        `SSH ${options.label} cancelada; nenhuma repetição automática foi feita.`,
        { outcomeUnknown: options.outcomeUnknownOnTimeout },
      ),
      true,
    );
  };

  const timer = setTimeout(() => {
    settle(
      'reject',
      new SshTransportError(
        'operation_timeout',
        `SSH ${options.label} excedeu ${options.timeoutMs}ms; reconecte e verifique o estado remoto antes de repetir.`,
        { outcomeUnknown: options.outcomeUnknownOnTimeout },
      ),
      true,
    );
  }, options.timeoutMs);
  timer.unref?.();

  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return {
    promise,
    isActive() {
      return !settled && options.isGenerationCurrent();
    },
    setCleanup(nextCleanup) {
      if (settled) {
        safeCleanup(nextCleanup);
        return;
      }
      cleanup = nextCleanup;
    },
    resolve(value) {
      if (!options.isGenerationCurrent()) {
        settle(
          'reject',
          new SshTransportError(
            'stale_generation',
            `SSH ${options.label} pertence a uma conexão anterior e foi descartada.`,
            { outcomeUnknown: options.outcomeUnknownOnTimeout },
          ),
          true,
        );
        return;
      }
      settle('resolve', value, false);
    },
    reject(error) {
      settle('reject', normalizeError(options.label, error), true);
    },
    cancel(error) {
      settle('reject', error, true);
    },
  };
}

function normalizeError(label: string, error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`SSH ${label} falhou: ${String(error)}`);
}

function safeCleanup(cleanup: (() => void) | null): void {
  try {
    cleanup?.();
  } catch {
    // Best-effort resource teardown must not replace the primary failure.
  }
}
