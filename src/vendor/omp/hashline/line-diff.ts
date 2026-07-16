// Vendored from can1357/oh-my-pi@03c48d073 packages/hashline (MIT)
// NexusIDE port note: upstream imports `diffArrays` from the `diff` (jsdiff)
// package, which is not a NexusIDE dependency. recovery.ts only needs an
// LCS-quality alignment of two line arrays, so this file implements the
// classic Myers O(ND) greedy diff with a common prefix/suffix fast path and a
// fail-closed budget: pathological inputs (edit distance beyond the budget)
// degrade to "everything changed", which makes recovery decline instead of
// stalling the main process.

/** One run of the diff: unchanged (neither flag), added, or removed values. */
export interface ArrayChange<T> {
  value: T[];
  added?: boolean;
  removed?: boolean;
}

/**
 * Edit-distance budget. Recovery diffs are file-sized but low-drift; a diff
 * that needs more than this many edit steps carries no usable anchor mapping
 * anyway, so the O(ND) search cuts off and reports a full rewrite. The
 * backtrack trace is O(budget^2) ints, so keep this in the low thousands.
 */
const MAX_EDIT_DISTANCE = 2_048;

function commonPrefixLength<T>(a: readonly T[], b: readonly T[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffixLength<T>(
  a: readonly T[],
  b: readonly T[],
  prefix: number,
): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let index = 0;
  while (index < limit && a[a.length - 1 - index] === b[b.length - 1 - index]) {
    index += 1;
  }
  return index;
}

interface EditScriptStep {
  /** `true` when the step consumes `b[index]` (insertion); otherwise it consumes `a[index]` (deletion). */
  insert: boolean;
  index: number;
}

/**
 * Myers greedy O(ND) shortest edit script between `a` and `b` in chronological
 * order, or `null` when the distance exceeds {@link MAX_EDIT_DISTANCE}.
 */
function shortestEditScript<T>(
  a: readonly T[],
  b: readonly T[],
): EditScriptStep[] | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = maxD;
  // v[offset + k] = furthest x reached on diagonal k so far.
  const v = new Int32Array(2 * maxD + 1);
  // trace[d] = snapshot of v BEFORE round d, compacted to diagonals [-d..d]
  // (snapshot[k + d] = v value for diagonal k).
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

/** Recover the chronological edit steps from the per-round snapshots. */
function backtrack(
  trace: readonly Int32Array[],
  distance: number,
  n: number,
  m: number,
): EditScriptStep[] {
  const steps: EditScriptStep[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d >= 1; d -= 1) {
    const snapshot = trace[d];
    const at = (k: number): number => snapshot[k + d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (prevK === k + 1) {
      // Downward move: insertion of b[prevY].
      steps.push({ insert: true, index: prevY });
    } else {
      // Rightward move: deletion of a[prevX].
      steps.push({ insert: false, index: prevX });
    }
    x = prevX;
    y = prevY;
  }
  steps.reverse();
  return steps;
}

/**
 * jsdiff-compatible `diffArrays`: aligns `oldArr` and `newArr` into ordered
 * runs of unchanged, removed, and added values (a removed run precedes the
 * added run covering the same region, like jsdiff).
 */
export function diffArrays<T>(
  oldArr: readonly T[],
  newArr: readonly T[],
): ArrayChange<T>[] {
  const prefix = commonPrefixLength(oldArr, newArr);
  const suffix = commonSuffixLength(oldArr, newArr, prefix);
  const aCore = oldArr.slice(prefix, oldArr.length - suffix);
  const bCore = newArr.slice(prefix, newArr.length - suffix);

  const changes: ArrayChange<T>[] = [];
  const pushRun = (value: T[], flag?: 'added' | 'removed'): void => {
    if (value.length === 0) return;
    const last = changes[changes.length - 1];
    if (
      last !== undefined &&
      (last.added === true) === (flag === 'added') &&
      (last.removed === true) === (flag === 'removed')
    ) {
      last.value.push(...value);
      return;
    }
    const change: ArrayChange<T> = { value };
    if (flag === 'added') change.added = true;
    if (flag === 'removed') change.removed = true;
    changes.push(change);
  };

  pushRun(oldArr.slice(0, prefix));

  const script =
    aCore.length === 0 && bCore.length === 0
      ? []
      : shortestEditScript(aCore, bCore);

  if (script === null) {
    // Over budget: report the whole middle as a rewrite. Fail-closed for
    // recovery — no unchanged-line mapping survives inside the region.
    pushRun([...aCore], 'removed');
    pushRun([...bCore], 'added');
  } else {
    let x = 0;
    let y = 0;
    let pendingRemoved: T[] = [];
    let pendingAdded: T[] = [];
    const flushPending = (): void => {
      pushRun(pendingRemoved, 'removed');
      pushRun(pendingAdded, 'added');
      pendingRemoved = [];
      pendingAdded = [];
    };
    const advanceEqual = (count: number): void => {
      if (count <= 0) return;
      flushPending();
      pushRun(aCore.slice(x, x + count));
      x += count;
      y += count;
    };
    for (const step of script) {
      if (step.insert) {
        advanceEqual(step.index - y);
        pendingAdded.push(bCore[y]);
        y += 1;
      } else {
        advanceEqual(step.index - x);
        pendingRemoved.push(aCore[x]);
        x += 1;
      }
    }
    if (aCore.length - x === bCore.length - y) {
      flushPending();
      advanceEqual(aCore.length - x);
    } else {
      // Defensive: a desynchronized script would corrupt the alignment; treat
      // the remainder as a rewrite instead.
      flushPending();
      pushRun(aCore.slice(x), 'removed');
      pushRun(bCore.slice(y), 'added');
    }
  }

  pushRun(oldArr.slice(oldArr.length - suffix));
  return changes;
}
