/**
 * Shared, transport-safe types used across main / preload / renderer.
 * Everything here must be JSON-serializable (it crosses the IPC boundary).
 */

import type { AdapterInfo } from './adapter-types';
import type {
  VoiceRuntimeInfo,
  TranscribeRequest,
  TranscribeResult,
  SpeakRequest,
  SpeakResult,
  SetConfigRequest,
} from './voice-ipc';
import type {
  Handoff,
  McpRuntimeInfo,
  Mission,
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
  Squad,
  TodoList,
} from './orch-types';

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
  /**
   * Present when the pane was requested by the orchestration layer (MCP
   * pane_spawn). Correlates the eventual PTY spawn with the pending skill-gate
   * context minted for that request.
   */
  orchRequestId?: string;
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
  /** Correlates an orchestration-requested spawn with its gate context. */
  orchRequestId?: string;
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
  voice: {
    getInfo(): Promise<VoiceRuntimeInfo>;
    setConfig(patch: SetConfigRequest): Promise<VoiceRuntimeInfo>;
    transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
    speak(req: SpeakRequest): Promise<SpeakResult>;
    onPttStart(cb: () => void): Unsubscribe;
    onPttStop(cb: () => void): Unsubscribe;
    onInfoChanged(cb: (info: VoiceRuntimeInfo) => void): Unsubscribe;
  };
  orch: {
    /** Mirror the current pane set into the main-process registry. */
    syncPanes(entries: PaneRegistryEntry[]): void;
    sendPaneSpawnResult(result: OrchPaneSpawnResult): void;
    onPaneSpawnRequest(cb: (req: OrchPaneSpawnRequest) => void): Unsubscribe;
    onPaneCloseRequest(cb: (paneId: string) => void): Unsubscribe;
    listMissions(): Promise<Mission[]>;
    listHandoffs(): Promise<Handoff[]>;
    getTodos(): Promise<TodoList[]>;
    listSquads(): Promise<Squad[]>;
    saveSquad(squad: Squad): Promise<{ ok: boolean; error?: string }>;
    deleteSquad(id: string): Promise<{ ok: boolean }>;
    exportSquads(): Promise<{ ok: boolean; path?: string; error?: string }>;
    importSquads(): Promise<{ ok: boolean; count?: number; error?: string }>;
    getMcpInfo(): Promise<McpRuntimeInfo>;
    onMissionsChanged(cb: (missions: Mission[]) => void): Unsubscribe;
    onHandoffsChanged(cb: (handoffs: Handoff[]) => void): Unsubscribe;
    onTodosChanged(cb: (lists: TodoList[]) => void): Unsubscribe;
    onSquadsChanged(cb: (squads: Squad[]) => void): Unsubscribe;
  };
  platform: NodeJS.Platform;
}
