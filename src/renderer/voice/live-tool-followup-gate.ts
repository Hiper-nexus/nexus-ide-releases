/**
 * Correlates a renderer tool follow-up request with the provider completion
 * that arrives after its tool result. Completion can race ahead of arming, so
 * the gate remembers the one completed turn until the renderer is ready.
 */
export interface LiveToolTurnKey {
  sessionId: string;
  turnId: string;
  /** A turn can contain more than one tool result; never release for the wrong one. */
  callId: string;
}

const MAX_REMEMBERED_COMPLETIONS = 8;

function keyOf(key: LiveToolTurnKey): string {
  return `${key.sessionId}\u0000${key.turnId}\u0000${key.callId}`;
}

function sameTurn(left: LiveToolTurnKey, right: LiveToolTurnKey): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.callId === right.callId
  );
}

export class LiveToolFollowUpGate<T> {
  private readonly pending = new Map<string, { key: LiveToolTurnKey; value: T }>();
  private readonly completed = new Map<string, LiveToolTurnKey>();

  arm(key: LiveToolTurnKey, value: T): T | null {
    const id = keyOf(key);
    const completed = this.completed.get(id);
    if (completed && sameTurn(completed, key)) {
      this.completed.delete(id);
      return value;
    }
    // Re-arm of the same tool turn only refreshes the payload — do not fork a
    // second follow-up mic for one callId (logs showed Pending→Ready→Pending).
    const existing = this.pending.get(id);
    if (existing && sameTurn(existing.key, key)) {
      this.pending.set(id, { key, value });
      return null;
    }
    this.pending.set(id, { key, value });
    return null;
  }

  /** True when this tool turn is already waiting for provider completion. */
  isArmed(key: LiveToolTurnKey): boolean {
    const id = keyOf(key);
    const existing = this.pending.get(id);
    return Boolean(existing && sameTurn(existing.key, key));
  }

  complete(key: LiveToolTurnKey): T | null {
    const id = keyOf(key);
    const pending = this.pending.get(id);
    if (pending && sameTurn(pending.key, key)) {
      this.pending.delete(id);
      const value = pending.value;
      return value;
    }
    this.completed.set(id, key);
    this.trimCompleted();
    return null;
  }

  clear(): void {
    this.pending.clear();
    this.completed.clear();
  }

  private trimCompleted(): void {
    while (this.completed.size > MAX_REMEMBERED_COMPLETIONS) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) return;
      this.completed.delete(oldest);
    }
  }
}
