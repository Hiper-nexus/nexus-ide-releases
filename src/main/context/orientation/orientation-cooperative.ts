const DEFAULT_CHUNK_SIZE = 128;

export function orientationAbortError(): Error {
  const error = new Error('orientation build aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfOrientationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw orientationAbortError();
}

/**
 * Yield at a macrotask boundary so renderer, PTY, and IPC events can run.
 * Promise microtasks are insufficient for long in-process scans because they
 * can starve Electron's event loop just as effectively as one synchronous
 * loop.
 */
export function yieldOrientationWork(signal?: AbortSignal): Promise<void> {
  throwIfOrientationAborted(signal);
  return new Promise((resolve, reject) => {
    const immediate = setImmediate(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
    const abort = () => {
      clearImmediate(immediate);
      reject(orientationAbortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function yieldOrientationChunk(
  processed: number,
  signal?: AbortSignal,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<void> {
  if (processed > 0 && processed % chunkSize === 0) {
    await yieldOrientationWork(signal);
    return;
  }
  throwIfOrientationAborted(signal);
}

/** Stable bottom-up merge sort with bounded event-loop occupancy. */
export async function sortOrientationItems<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  signal?: AbortSignal,
): Promise<readonly T[]> {
  if (values.length < 2) return Object.freeze([...values]);
  let source = [...values];
  let target = new Array<T>(source.length);
  let comparisons = 0;
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let left = start;
      let right = middle;
      let output = start;
      while (left < middle || right < end) {
        if (
          right >= end ||
          (left < middle && compare(source[left], source[right]) <= 0)
        ) {
          target[output] = source[left];
          left += 1;
        } else {
          target[output] = source[right];
          right += 1;
        }
        output += 1;
        comparisons += 1;
        if (comparisons % 2_048 === 0) {
          await yieldOrientationWork(signal);
        }
      }
    }
    [source, target] = [target, source];
  }
  return Object.freeze(source);
}
