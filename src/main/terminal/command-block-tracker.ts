import { randomUUID } from 'node:crypto';
import {
  completeCommandBlock,
  createCommandBlock,
  type CommandBlock,
} from '../../shared/command-block';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { computeCommandBlockIdempotencyKey } from './command-block-id';
import { redactCommandLine } from './command-redaction';
import { clearCommandBlockScope } from './command-block-scope-registry';
import {
  isSafeOscCwd,
  Osc133Scanner,
  type Osc133Event,
} from './shell-integration-osc133';

/**
 * Lateral semantic layer over PTY data taps. Does not alter the byte stream.
 * Active only when feature.terminal.commandBlocks is enabled.
 */

export interface CommandBlockSessionMeta {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly shell: string;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly gitBranch?: string;
  readonly missionId?: string;
}

interface LiveSession {
  readonly meta: CommandBlockSessionMeta;
  readonly scanner: Osc133Scanner;
  cwd: string;
  running: CommandBlock | null;
  pendingCommand: string | null;
  blocks: CommandBlock[];
}

export interface CommandBlockTrackerOptions {
  readonly isEnabled?: () => boolean;
  readonly now?: () => number;
  readonly onBlock?: (block: CommandBlock) => void;
  readonly maxBlocksPerSession?: number;
}

export class CommandBlockTracker {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #isEnabled: () => boolean;
  readonly #now: () => number;
  readonly #onBlock?: (block: CommandBlock) => void;
  readonly #maxBlocks: number;
  #untapData: (() => void) | null = null;
  #untapExit: (() => void) | null = null;

  constructor(options: CommandBlockTrackerOptions = {}) {
    this.#isEnabled =
      options.isEnabled ??
      (() => getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.terminalCommandBlocks));
    this.#now = options.now ?? Date.now;
    this.#onBlock = options.onBlock;
    this.#maxBlocks = options.maxBlocksPerSession ?? 200;
  }

  start(): void {
    if (this.#untapData) return;
    this.#untapData = tapSessionData((sessionId, data) => {
      this.handleData(sessionId, data);
    });
    this.#untapExit = tapSessionExit((sessionId) => {
      this.handleExit(sessionId);
    });
  }

  stop(): void {
    this.#untapData?.();
    this.#untapExit?.();
    this.#untapData = null;
    this.#untapExit = null;
    this.#sessions.clear();
  }

  /** Bind session metadata before/while OSC events arrive. */
  bindSession(sessionId: string, meta: CommandBlockSessionMeta): void {
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      this.#sessions.set(sessionId, {
        ...existing,
        meta,
        cwd: isSafeOscCwd(meta.cwd) ? meta.cwd : existing.cwd,
      });
      return;
    }
    this.#sessions.set(sessionId, {
      meta,
      scanner: new Osc133Scanner(),
      cwd: isSafeOscCwd(meta.cwd) ? meta.cwd : '/',
      running: null,
      pendingCommand: null,
      blocks: [],
    });
  }

  handleData(sessionId: string, data: string): void {
    if (!this.#isEnabled()) return;
    let session = this.#sessions.get(sessionId);
    if (!session) {
      // Lazy session: semantic layer without meta still tracks lifecycle.
      session = {
        meta: {
          paneId: sessionId,
          workspaceId: 'unknown',
          shell: 'unknown',
          cwd: '/',
        },
        scanner: new Osc133Scanner(),
        cwd: '/',
        running: null,
        pendingCommand: null,
        blocks: [],
      };
      this.#sessions.set(sessionId, session);
    }

    for (const event of session.scanner.push(data)) {
      this.#applyEvent(sessionId, session, event);
    }
  }

  listBlocks(sessionId: string): readonly CommandBlock[] {
    return this.#sessions.get(sessionId)?.blocks ?? [];
  }

  findBlock(sessionId: string, blockId: string): CommandBlock | null {
    return this.listBlocks(sessionId).find((b) => b.id === blockId) ?? null;
  }

  /** All tracked blocks for a pane (newest last in each session). */
  listByPane(paneId: string): readonly CommandBlock[] {
    const out: CommandBlock[] = [];
    for (const session of this.#sessions.values()) {
      if (session.meta.paneId === paneId) {
        out.push(...session.blocks);
      }
    }
    return out;
  }

  /** Persist an unterminated command as unknown before dropping PTY state. */
  handleExit(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session?.running) {
      const done = completeCommandBlock(session.running, {
        endedAt: this.#now(),
        status: 'unknown',
      });
      this.#onBlock?.(done);
    }
    this.#sessions.delete(sessionId);
    clearCommandBlockScope(sessionId);
  }

  #applyEvent(
    sessionId: string,
    session: LiveSession,
    event: Osc133Event,
  ): void {
    switch (event.kind) {
      case 'cwd':
        if (isSafeOscCwd(event.path)) session.cwd = event.path;
        return;
      case 'command_line':
        session.pendingCommand = event.command;
        return;
      case 'command_start':
      case 'command_executed': {
        if (session.running) return;
        const rawCommand = session.pendingCommand ?? '';
        session.pendingCommand = null;
        if (!rawCommand.trim()) return;
        const scrubbed = redactCommandLine(rawCommand);
        const startedAt = this.#now();
        const block = createCommandBlock({
          id: `cb-${randomUUID()}`,
          sessionId,
          paneId: session.meta.paneId,
          workspaceId: session.meta.workspaceId,
          missionId: session.meta.missionId,
          command: scrubbed.command,
          cwd: session.cwd,
          projectRoot: session.meta.projectRoot,
          shell: session.meta.shell,
          gitBranch: session.meta.gitBranch,
          startedAt,
          status: 'running',
          redaction: {
            redacted: scrubbed.redacted || scrubbed.denylisted,
            denylisted: scrubbed.denylisted,
            secretHits: scrubbed.secretHits,
          },
          idempotencyKey: computeCommandBlockIdempotencyKey({
            sessionId,
            startedAt,
            command: scrubbed.command,
            cwd: session.cwd,
          }),
        });
        session.running = block;
        return;
      }
      case 'command_finished': {
        if (!session.running) return;
        const endedAt = this.#now();
        const exitCode = event.exitCode;
        const status =
          exitCode === undefined
            ? 'unknown'
            : exitCode === 0
              ? 'success'
              : 'failed';
        const done = completeCommandBlock(session.running, {
          endedAt,
          exitCode,
          status,
        });
        session.running = null;
        session.blocks.push(done);
        if (session.blocks.length > this.#maxBlocks) {
          session.blocks.splice(0, session.blocks.length - this.#maxBlocks);
        }
        this.#onBlock?.(done);
        return;
      }
      default:
        return;
    }
  }
}

let singleton: CommandBlockTracker | null = null;
let persistHook: ((block: CommandBlock) => void) | null = null;

/**
 * Install production onBlock persistence before or after ensure.
 * Replaces any previous hook and rebinds the singleton when present.
 */
export function setCommandBlockPersistHook(
  hook: ((block: CommandBlock) => void) | null,
): void {
  persistHook = hook;
  if (singleton) {
    // Restart tracker with the new onBlock so production path hits SQLite.
    const enabled = () =>
      getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.terminalCommandBlocks);
    singleton.stop();
    singleton = new CommandBlockTracker({
      isEnabled: enabled,
      onBlock: (block) => persistHook?.(block),
    });
    singleton.start();
  }
}

/** Idempotent main-process bootstrap. Safe when flag is off (no-op path). */
export function ensureCommandBlockTracking(): CommandBlockTracker {
  if (!singleton) {
    singleton = new CommandBlockTracker({
      onBlock: (block) => persistHook?.(block),
    });
    singleton.start();
  }
  return singleton;
}

export function getCommandBlockTracker(): CommandBlockTracker | null {
  return singleton;
}

/** Test-only. */
export function resetCommandBlockTrackingForTests(): void {
  singleton?.stop();
  singleton = null;
  persistHook = null;
}
