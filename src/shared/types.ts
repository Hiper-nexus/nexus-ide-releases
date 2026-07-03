/**
 * Shared, transport-safe types used across main / preload / renderer.
 * Everything here must be JSON-serializable (it crosses the IPC boundary).
 */

/**
 * The kind of process backing a pane. Today only `shell` is implemented, but
 * the pane abstraction is intentionally session-kind aware so later phases can
 * plug an AI CLI adapter (`cli-agent`) into the exact same grid/PTY plumbing.
 */
export type SessionKind = 'shell' | 'cli-agent';

export type SplitDirection = 'row' | 'column';

/** A single terminal pane (a leaf in the layout tree). */
export interface PaneModel {
  id: string;
  kind: SessionKind;
  title: string;
  cwd?: string;
}

/**
 * Recursive binary layout tree. A leaf hosts one pane; a split holds exactly
 * two children arranged along a direction. Splitting a pane replaces its leaf
 * with a split node; closing a pane collapses the split back to its sibling.
 */
export type LayoutNode =
  | { kind: 'leaf'; id: string; pane: PaneModel }
  | {
      kind: 'split';
      id: string;
      direction: SplitDirection;
      children: [LayoutNode, LayoutNode];
    };

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
}

/** Payload to open a PTY session for a pane. */
export interface SpawnRequest {
  cwd?: string;
  shell?: string;
  cols: number;
  rows: number;
  kind: SessionKind;
}

export type SpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

export interface PtyDataEvent {
  sessionId: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

/** Unsubscribe handle returned by the event subscription helpers. */
export type Unsubscribe = () => void;

/**
 * The typed surface exposed on `window.nexus` by the preload script.
 * The renderer NEVER sees raw ipcRenderer — only this contract.
 */
export interface NexusApi {
  pty: {
    spawn(req: SpawnRequest): Promise<SpawnResult>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): void;
    onData(sessionId: string, cb: (data: string) => void): Unsubscribe;
    onExit(
      sessionId: string,
      cb: (event: { exitCode: number; signal?: number }) => void,
    ): Unsubscribe;
  };
  layout: {
    save(layout: WorkspaceLayout): Promise<{ ok: boolean }>;
    load(): Promise<WorkspaceLayout | null>;
  };
  platform: NodeJS.Platform;
}
