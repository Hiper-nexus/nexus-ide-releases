/**
 * Clean-room persistent PTY backend (Xirp/squab-inspired model, not code).
 * When tmux is available, agent processes live in named sessions so app quit
 * only drops the attach client; reopen reattaches.
 *
 * Spawn path in pty-manager is synchronous, so sync helpers use execFileSync.
 */

import { execFileSync } from 'node:child_process';

export type TmuxRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type TmuxRunnerSync = (
  args: string[],
  opts?: { timeoutMs?: number },
) => { code: number; stdout: string; stderr: string };

const TMUX_NAME_MAX = 80;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Sanitize workspace + pane into a stable tmux session name. */
export function tmuxSessionName(workspaceId: string, paneId: string): string {
  const raw = `nexus-${workspaceId}-${paneId}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-');
  const trimmed = cleaned.replace(/^-+|-+$/g, '');
  if (trimmed.length <= TMUX_NAME_MAX) return trimmed || 'nexus-session';
  return trimmed.slice(0, TMUX_NAME_MAX).replace(/-+$/g, '') || 'nexus-session';
}

async function defaultRunner(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args, {
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    });
    return {
      code: 0,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
    };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const code =
      typeof e.code === 'number'
        ? e.code
        : e.killed
          ? 124
          : 1;
    return {
      code,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

function defaultRunnerSync(
  args: string[],
  opts?: { timeoutMs?: number },
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('tmux', args, {
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    return {
      code: typeof e.status === 'number' ? e.status : e.killed ? 124 : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

export interface PersistentSessionBackend {
  probeAvailable(): Promise<boolean>;
  probeAvailableSync(): boolean;
  hasSession(name: string): Promise<boolean>;
  hasSessionSync(name: string): boolean;
  ensureSession(input: {
    name: string;
    cwd: string;
    command: string;
    args: readonly string[];
  }): Promise<'created' | 'exists'>;
  ensureSessionSync(input: {
    name: string;
    cwd: string;
    command: string;
    args: readonly string[];
  }): 'created' | 'exists';
  attachArgs(name: string): { file: string; args: string[] };
  killSession(name: string): Promise<void>;
  killSessionSync(name: string): void;
  listNexusSessions(): Promise<string[]>;
}

export function createPersistentSessionBackend(
  runner: TmuxRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
  runnerSync: TmuxRunnerSync = defaultRunnerSync,
): PersistentSessionBackend {
  return {
    async probeAvailable(): Promise<boolean> {
      if (platform === 'win32') return false;
      const result = await runner(['-V'], { timeoutMs: 2_000 });
      return result.code === 0;
    },

    probeAvailableSync(): boolean {
      if (platform === 'win32') return false;
      return runnerSync(['-V'], { timeoutMs: 2_000 }).code === 0;
    },

    async hasSession(name: string): Promise<boolean> {
      const result = await runner(['has-session', '-t', name], {
        timeoutMs: 2_000,
      });
      return result.code === 0;
    },

    hasSessionSync(name: string): boolean {
      return (
        runnerSync(['has-session', '-t', name], { timeoutMs: 2_000 }).code ===
        0
      );
    },

    async ensureSession(input): Promise<'created' | 'exists'> {
      if (await this.hasSession(input.name)) return 'exists';
      const args = [
        'new-session',
        '-d',
        '-s',
        input.name,
        '-c',
        input.cwd,
        input.command,
        ...input.args,
      ];
      const result = await runner(args, { timeoutMs: 10_000 });
      if (result.code !== 0) {
        throw new Error(
          `tmux new-session failed (${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      return 'created';
    },

    ensureSessionSync(input): 'created' | 'exists' {
      if (this.hasSessionSync(input.name)) return 'exists';
      const args = [
        'new-session',
        '-d',
        '-s',
        input.name,
        '-c',
        input.cwd,
        input.command,
        ...input.args,
      ];
      const result = runnerSync(args, { timeoutMs: 10_000 });
      if (result.code !== 0) {
        throw new Error(
          `tmux new-session failed (${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      return 'created';
    },

    attachArgs(name: string): { file: string; args: string[] } {
      return { file: 'tmux', args: ['attach-session', '-t', name] };
    },

    async killSession(name: string): Promise<void> {
      await runner(['kill-session', '-t', name], { timeoutMs: 5_000 });
    },

    killSessionSync(name: string): void {
      runnerSync(['kill-session', '-t', name], { timeoutMs: 5_000 });
    },

    async listNexusSessions(): Promise<string[]> {
      const result = await runner(['list-sessions', '-F', '#S'], {
        timeoutMs: 3_000,
      });
      if (result.code !== 0) return [];
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('nexus-'));
    },
  };
}

/** Shared singleton for main-process spawn/quit paths. */
let sharedBackend: PersistentSessionBackend | null = null;

export function getPersistentSessionBackend(): PersistentSessionBackend {
  if (!sharedBackend) {
    sharedBackend = createPersistentSessionBackend();
  }
  return sharedBackend;
}

/** Test isolation. */
export function __setPersistentSessionBackendForTests(
  backend: PersistentSessionBackend | null,
): void {
  sharedBackend = backend;
}

/**
 * Decide whether a resolved agent spawn should be wrapped in tmux.
 * Skip sealed/native-confined launches — authenticity binds the CLI binary.
 */
export function planPersistentAgentSpawn(input: {
  enabled: boolean;
  workspaceId: string;
  paneId: string | undefined;
  cwd: string;
  file: string;
  args: readonly string[];
  sealedNative: boolean;
  backend?: PersistentSessionBackend;
}): {
  mode: 'direct' | 'tmux';
  file: string;
  args: string[];
  tmuxName?: string;
} {
  if (
    !input.enabled ||
    input.sealedNative ||
    !input.paneId ||
    !input.workspaceId
  ) {
    return { mode: 'direct', file: input.file, args: [...input.args] };
  }
  const backend = input.backend ?? getPersistentSessionBackend();
  if (!backend.probeAvailableSync()) {
    return { mode: 'direct', file: input.file, args: [...input.args] };
  }
  const name = tmuxSessionName(input.workspaceId, input.paneId);
  try {
    if (backend.hasSessionSync(name)) {
      const attach = backend.attachArgs(name);
      return {
        mode: 'tmux',
        file: attach.file,
        args: attach.args,
        tmuxName: name,
      };
    }
    backend.ensureSessionSync({
      name,
      cwd: input.cwd,
      command: input.file,
      args: input.args,
    });
    const attach = backend.attachArgs(name);
    return {
      mode: 'tmux',
      file: attach.file,
      args: attach.args,
      tmuxName: name,
    };
  } catch (err) {
    console.warn(
      '[pty] persistentSession fallback to direct spawn:',
      err instanceof Error ? err.message : err,
    );
    return { mode: 'direct', file: input.file, args: [...input.args] };
  }
}
