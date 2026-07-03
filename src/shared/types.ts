/**
 * Shared, transport-safe types used across main / preload / renderer.
 * Everything here must be JSON-serializable (it crosses the IPC boundary).
 */

import type { AdapterInfo } from './adapter-types';

export type { AdapterInfo };

/**
 * The kind of process backing a pane. `shell` uses the user's default shell;
 * `cli-agent` spawns an AI CLI via a declarative adapter JSON.
 */
export type SessionKind = 'shell' | 'cli-agent';

export type SplitDirection = 'row' | 'column';

/** A single terminal pane (a leaf in the layout tree). */
export interface PaneModel {
  id: string;
  kind: SessionKind;
  title: string;
  cwd?: string;
  /** Set for cli-agent panes — identifies which adapter backs this pane. */
  adapterId?: string;
  /** The model selected for this agent pane (e.g. "claude-sonnet-4-5"). */
  model?: string;
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

export type ViewKind = 'grid' | 'canvas';

/** Position/size of one pane in the infinite canvas. */
export interface CanvasNodeLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  z: number;
}

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
  /** Active view: grid (default) or infinite canvas. */
  viewKind?: ViewKind;
  /** Per-pane canvas position+size, keyed by paneId. */
  canvasNodeLayouts?: Record<string, CanvasNodeLayout>;
  /** Last canvas viewport (x, y, zoom) for restore. */
  canvasViewport?: { x: number; y: number; zoom: number };
}

/** Payload to open a PTY session for a pane. */
export interface SpawnRequest {
  cwd?: string;
  shell?: string;
  cols: number;
  rows: number;
  kind: SessionKind;
  /** Present when kind === 'cli-agent'. */
  adapterId?: string;
  /** Present when kind === 'cli-agent'. Falls back to adapter's default model. */
  model?: string;
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

export type PaneSessionState = 'spawning' | 'busy' | 'idle';

export interface PtyStateChangeEvent {
  sessionId: string;
  state: PaneSessionState;
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
    onStateChange(
      sessionId: string,
      cb: (state: PaneSessionState) => void,
    ): Unsubscribe;
  };
  layout: {
    save(layout: WorkspaceLayout): Promise<{ ok: boolean }>;
    load(): Promise<WorkspaceLayout | null>;
  };
  adapters: {
    list(): Promise<AdapterInfo[]>;
    onChanged(cb: (adapters: AdapterInfo[]) => void): Unsubscribe;
  };
  platform: NodeJS.Platform;
}
