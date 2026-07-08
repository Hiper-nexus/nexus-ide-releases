/**
 * Single-execution-owner guard for one conversational voice turn (NEW-A).
 *
 * A realtime native tool-call and the Classic brain (runJarvisTurn) can both try
 * to act on the SAME utterance: the toolCall arrives on the fire-and-forget
 * `onLiveToolCall` IPC while `finishAndProcess` drives Classic off the resolved
 * transcript. IPC ordering is not guaranteed, so a timestamp heuristic
 * (`hasRealtimeNativeToolSince`) can let BOTH run → a duplicate
 * `send_to_pane`/delegation.
 *
 * This guard makes execution mutually exclusive per turn: the first path to
 * claim the current turn wins; the loser no-ops. Claims are synchronous, so
 * within the renderer's single-threaded event loop the check-and-set is atomic —
 * exactly one caller can transition the owner away from `null`, regardless of
 * which IPC microtask runs first. The turn token additionally rejects a stale
 * claim from a PREVIOUS turn (a late toolCall landing after a new turn opened).
 */
export type TurnExecutionPath = 'realtime-tool' | 'classic-brain';

export class TurnExecutionOwner {
  private token = 0;
  private claimed: TurnExecutionPath | null = null;

  /** Open a fresh conversational turn (call at capture start). Returns its token. */
  beginTurn(): number {
    this.token += 1;
    this.claimed = null;
    return this.token;
  }

  /** Token of the turn currently open. */
  get currentToken(): number {
    return this.token;
  }

  /** Which path (if any) owns the current turn's execution. */
  get owner(): TurnExecutionPath | null {
    return this.claimed;
  }

  /**
   * Attempt to become the single execution owner of `token`. Returns true only
   * for the FIRST caller of a still-open, unclaimed turn; every later caller (or
   * a caller carrying a stale token) gets false and must no-op.
   */
  claim(path: TurnExecutionPath, token: number): boolean {
    if (token !== this.token) return false;
    if (this.claimed !== null) return false;
    this.claimed = path;
    return true;
  }
}
