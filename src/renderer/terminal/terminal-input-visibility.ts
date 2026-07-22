// Copyright (c) 2026 Lovecast Inc. — MIT License

/**
 * Keeps interactive terminal input visible even when a pane was left in
 * scrollback or its renderer missed an incremental paint.
 *
 * PTYs own echo and full-screen TUIs own their composer, so xterm cannot draw
 * the user's text locally. The safe contract is instead: return to the live
 * viewport before forwarding a key, then coalesce one explicit repaint after
 * the PTY parses the response. This is intentionally renderer-only and never
 * invents bytes for the child process.
 */

const INPUT_REPAINT_WINDOW_MS = 750;
const HISTORY_CLASS = 'term-host--history';

export interface TerminalInputSurface {
  readonly rows: number;
  scrollToBottom(): void;
  refresh(start: number, end: number): void;
}

export interface TerminalHistoryIndicator {
  toggle(name: string, force?: boolean): boolean;
}

export interface TerminalInputVisibilityOptions {
  term: TerminalInputSurface;
  classList: TerminalHistoryIndicator;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export class TerminalInputVisibilityController {
  private following = true;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private repaintFrame: number | null = null;
  private readonly now: () => number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(private readonly options: TerminalInputVisibilityOptions) {
    this.now = options.now ?? (() => performance.now());
    this.requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  }

  get isFollowing(): boolean {
    return this.following;
  }

  /** Mirror xterm's viewport state and make scrollback mode explicit in UI. */
  onScroll(viewportY: number, baseY: number): void {
    this.setFollowing(viewportY >= baseY);
  }

  /**
   * Called before a real user key is sent to the PTY. Returning to the bottom
   * first guarantees that the process-owned echo/composer is on screen.
   */
  onUserInput(): void {
    this.lastInputAt = this.now();
    this.setFollowing(true);
    try {
      this.options.term.scrollToBottom();
    } catch {
      // A key must still reach the PTY if the renderer is between mounts.
    }
    this.scheduleRepaint();
  }

  /** Run after xterm parsed a PTY frame, coalesced to one repaint per frame. */
  onOutputParsed(): void {
    if (this.following) {
      try {
        this.options.term.scrollToBottom();
      } catch {
        // Parsing/output delivery must not fail because the viewport moved.
      }
    }
    if (this.now() - this.lastInputAt <= INPUT_REPAINT_WINDOW_MS) {
      this.scheduleRepaint();
    }
  }

  /** Used by restored snapshots and explicit "Fim" navigation. */
  follow(): void {
    this.setFollowing(true);
  }

  /** Recover immediately after a renderer/context loss. */
  repaintNow(): void {
    if (this.repaintFrame !== null) {
      this.cancelFrame(this.repaintFrame);
      this.repaintFrame = null;
    }
    this.repaintVisibleRows();
  }

  dispose(): void {
    if (this.repaintFrame !== null) {
      this.cancelFrame(this.repaintFrame);
      this.repaintFrame = null;
    }
  }

  private setFollowing(following: boolean): void {
    this.following = following;
    this.options.classList.toggle(HISTORY_CLASS, !following);
  }

  private scheduleRepaint(): void {
    if (this.repaintFrame !== null) return;
    this.repaintFrame = this.requestFrame(() => {
      this.repaintFrame = null;
      this.repaintVisibleRows();
    });
  }

  private repaintVisibleRows(): void {
    try {
      this.options.term.refresh(0, Math.max(0, this.options.term.rows - 1));
    } catch {
      // xterm can be between open/reparent/dispose; the next frame retries.
    }
  }
}
