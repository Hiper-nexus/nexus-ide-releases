/**
 * Mission-scoped prompt queue with monotonic sequence and intentVersion
 * preemption. Pure domain — no I/O.
 *
 * Newer user/voice messages cancel preemptible in-flight work (preflight,
 * bootstrap, compile) without waiting for the old cycle to finish.
 */

export type MissionPromptKind =
  | 'user_goal'
  | 'user_message'
  | 'voice_goal'
  | 'voice_message'
  | 'preflight'
  | 'bootstrap'
  | 'system';

export type MissionPromptStatus =
  | 'queued'
  | 'executing'
  | 'cancelled'
  | 'delivered'
  | 'failed';

/** Work that may be cancelled when intentVersion advances. */
export const PREEMPTIBLE_PROMPT_KINDS: ReadonlySet<MissionPromptKind> = new Set([
  'preflight',
  'bootstrap',
  'system',
]);

export interface MissionPromptItem {
  readonly id: string;
  readonly missionId: string;
  readonly seq: number;
  readonly intentVersion: number;
  readonly kind: MissionPromptKind;
  readonly body: string;
  readonly status: MissionPromptStatus;
  readonly createdAt: number;
  readonly source: 'typed' | 'voice' | 'system';
}

export interface MissionPromptQueueState {
  readonly missionId: string;
  readonly nextSeq: number;
  readonly items: readonly MissionPromptItem[];
  /** Highest intentVersion observed for this mission. */
  readonly currentIntentVersion: number;
  readonly executingId: string | null;
}

export function createEmptyPromptQueue(missionId: string): MissionPromptQueueState {
  return {
    missionId,
    nextSeq: 1,
    items: [],
    currentIntentVersion: 0,
    executingId: null,
  };
}

export type PromptQueueEvent =
  | {
      readonly type: 'enqueue';
      readonly kind: MissionPromptKind;
      readonly body: string;
      readonly intentVersion: number;
      readonly source: 'typed' | 'voice' | 'system';
      readonly now?: number;
      readonly id?: string;
    }
  | { readonly type: 'start'; readonly id: string }
  | { readonly type: 'cancel'; readonly id: string }
  | { readonly type: 'complete'; readonly id: string; readonly ok: boolean }
  | { readonly type: 'bump_intent'; readonly intentVersion: number };

export interface PromptQueueReduceResult {
  readonly state: MissionPromptQueueState;
  /** Ids cancelled by this event (preemption). */
  readonly cancelledIds: readonly string[];
}

function replaceItem(
  items: readonly MissionPromptItem[],
  id: string,
  patch: Partial<MissionPromptItem>,
): MissionPromptItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/**
 * Reduce queue state. Enqueue with a higher intentVersion cancels all
 * preemptible items that are queued or executing at a lower version.
 */
export function reducePromptQueue(
  state: MissionPromptQueueState,
  event: PromptQueueEvent,
): PromptQueueReduceResult {
  if (event.type === 'bump_intent') {
    if (event.intentVersion <= state.currentIntentVersion) {
      return { state, cancelledIds: [] };
    }
    const cancelledIds: string[] = [];
    const items = state.items.map((item) => {
      if (
        item.intentVersion < event.intentVersion &&
        PREEMPTIBLE_PROMPT_KINDS.has(item.kind) &&
        (item.status === 'queued' || item.status === 'executing')
      ) {
        cancelledIds.push(item.id);
        return { ...item, status: 'cancelled' as const };
      }
      return item;
    });
    return {
      state: {
        ...state,
        currentIntentVersion: event.intentVersion,
        items,
        executingId:
          state.executingId && cancelledIds.includes(state.executingId)
            ? null
            : state.executingId,
      },
      cancelledIds,
    };
  }

  if (event.type === 'enqueue') {
    const intentVersion = event.intentVersion;
    const id = event.id ?? `pq-${state.missionId}-${state.nextSeq}`;
    const duplicate = state.items.find((item) => item.id === id);
    if (duplicate) {
      const isSamePrompt =
        duplicate.kind === event.kind &&
        duplicate.body === event.body &&
        duplicate.intentVersion === intentVersion &&
        duplicate.source === event.source;
      if (!isSamePrompt) {
        throw new Error(`duplicate prompt id conflicts with existing work: ${id}`);
      }
      return { state, cancelledIds: [] };
    }
    let working: MissionPromptQueueState = state;
    let cancelledIds: string[] = [];

    if (intentVersion > state.currentIntentVersion) {
      const bumped = reducePromptQueue(state, {
        type: 'bump_intent',
        intentVersion,
      });
      working = bumped.state;
      cancelledIds = [...bumped.cancelledIds];
    }

    // User/voice messages also preempt stale preemptible work at same version
    // when something is still executing from an older cycle.
    if (
      event.source === 'typed' ||
      event.source === 'voice' ||
      event.kind === 'user_goal' ||
      event.kind === 'user_message' ||
      event.kind === 'voice_goal' ||
      event.kind === 'voice_message'
    ) {
      const extra: string[] = [];
      const items = working.items.map((item) => {
        if (
          item.intentVersion < intentVersion &&
          PREEMPTIBLE_PROMPT_KINDS.has(item.kind) &&
          (item.status === 'queued' || item.status === 'executing')
        ) {
          extra.push(item.id);
          return { ...item, status: 'cancelled' as const };
        }
        return item;
      });
      if (extra.length > 0) {
        cancelledIds = [...cancelledIds, ...extra];
        working = {
          ...working,
          items,
          executingId:
            working.executingId && extra.includes(working.executingId)
              ? null
              : working.executingId,
        };
      }
    }

    const isStale = intentVersion < working.currentIntentVersion;
    const item: MissionPromptItem = {
      id,
      missionId: working.missionId,
      seq: working.nextSeq,
      intentVersion,
      kind: event.kind,
      body: event.body,
      status: isStale ? 'cancelled' : 'queued',
      createdAt: event.now ?? Date.now(),
      source: event.source,
    };

    return {
      state: {
        ...working,
        nextSeq: working.nextSeq + 1,
        currentIntentVersion: Math.max(working.currentIntentVersion, intentVersion),
        items: [...working.items, item],
      },
      cancelledIds: isStale ? [...cancelledIds, id] : cancelledIds,
    };
  }

  if (event.type === 'start') {
    const item = state.items.find((entry) => entry.id === event.id);
    if (!item || item.status !== 'queued' || state.executingId) {
      return { state, cancelledIds: [] };
    }
    return {
      state: {
        ...state,
        executingId: event.id,
        items: replaceItem(state.items, event.id, { status: 'executing' }),
      },
      cancelledIds: [],
    };
  }

  if (event.type === 'cancel') {
    const item = state.items.find((entry) => entry.id === event.id);
    if (!item || (item.status !== 'queued' && item.status !== 'executing')) {
      return { state, cancelledIds: [] };
    }
    return {
      state: {
        ...state,
        executingId: state.executingId === event.id ? null : state.executingId,
        items: replaceItem(state.items, event.id, { status: 'cancelled' }),
      },
      cancelledIds: [event.id],
    };
  }

  // complete
  const item = state.items.find((entry) => entry.id === event.id);
  if (!item) return { state, cancelledIds: [] };
  if (item.status === 'cancelled') {
    return {
      state: {
        ...state,
        executingId: state.executingId === event.id ? null : state.executingId,
      },
      cancelledIds: [],
    };
  }
  if (item.status !== 'executing' || state.executingId !== event.id) {
    return { state, cancelledIds: [] };
  }
  return {
    state: {
      ...state,
      executingId: state.executingId === event.id ? null : state.executingId,
      items: replaceItem(state.items, event.id, {
        status: event.ok ? 'delivered' : 'failed',
      }),
    },
    cancelledIds: [],
  };
}

/** Next queued item that is not cancelled (FIFO by seq). */
export function nextDeliverablePrompt(
  state: MissionPromptQueueState,
): MissionPromptItem | null {
  if (state.executingId) return null;
  const pending = state.items
    .filter((item) => item.status === 'queued')
    .sort((a, b) => a.seq - b.seq);
  return pending[0] ?? null;
}

export function promptQueueSnapshot(state: MissionPromptQueueState): {
  readonly executing: MissionPromptItem | null;
  readonly queued: readonly MissionPromptItem[];
  readonly cancelled: readonly MissionPromptItem[];
} {
  return {
    executing:
      state.items.find(
        (item) => item.id === state.executingId && item.status === 'executing',
      ) ?? null,
    queued: state.items.filter((item) => item.status === 'queued'),
    cancelled: state.items.filter((item) => item.status === 'cancelled'),
  };
}
