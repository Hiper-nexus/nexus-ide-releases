/**
 * Clean-room persistent PTY backend (Xirp/squab-inspired model, not code).
 * When tmux is available, agent processes live in named sessions so app quit
 * only drops the attach client; reopen reattaches.
 *
 * Spawn path in pty-manager is synchronous, so sync helpers use execFileSync.
 */

import { createHash } from 'node:crypto';
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
const WORKSPACE_HASH_LEN = 16;
const DEFAULT_TIMEOUT_MS = 5_000;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Cap env pairs passed as repeated `-e` to keep argv bounded. */
const MAX_ENV_ENTRIES = 256;

let warnedTmuxMissing = false;
let warnedSealedSkip = false;
let warnedSandboxSkip = false;

/** Exact-match tmux target (`=` prevents prefix collisions after truncation). */
export function tmuxTarget(name: string): string {
  return `=${name}`;
}

function sanitizeTmuxToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable tmux session name that keeps the pane identity even for long
 * workspace paths. Format: `nexus-<sha256(workspace)[0:16]>-<paneSanitized>`.
 * Truncation (if any) eats the pane token from the end only after the hash.
 */
export function tmuxSessionName(workspaceId: string, paneId: string): string {
  const wsHash = createHash('sha256')
    .update(workspaceId)
    .digest('hex')
    .slice(0, WORKSPACE_HASH_LEN);
  const pane = sanitizeTmuxToken(paneId) || 'pane';
  const prefix = `nexus-${wsHash}-`;
  const maxPane = TMUX_NAME_MAX - prefix.length;
  if (maxPane < 1) return `nexus-${wsHash}`.slice(0, TMUX_NAME_MAX);
  if (pane.length <= maxPane) return `${prefix}${pane}`;
  return `${prefix}${pane.slice(0, maxPane).replace(/-+$/g, '')}`;
}

/**
 * Build repeated `tmux -e KEY=VALUE` args. Drops invalid keys and caps count.
 * Values may contain `=` (tmux splits on first `=`).
 */
export function tmuxEnvArgs(
  env: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!env) return [];
  const out: string[] = [];
  let count = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (typeof value !== 'string') continue;
    if (key.includes('\0') || value.includes('\0')) continue;
    out.push('-e', `${key}=${value}`);
    count += 1;
    if (count >= MAX_ENV_ENTRIES) break;
  }
  return out;
}

export interface EnsureSessionInput {
  name: string;
  cwd: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
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
      typeof e.code === 'number' ? e.code : e.killed ? 124 : 1;
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

function newSessionArgs(input: EnsureSessionInput): string[] {
  return [
    'new-session',
    '-d',
    '-s',
    input.name,
    '-c',
    input.cwd,
    ...tmuxEnvArgs(input.env),
    input.command,
    ...input.args,
  ];
}

export interface PersistentSessionBackend {
  probeAvailable(): Promise<boolean>;
  probeAvailableSync(): boolean;
  hasSession(name: string): Promise<boolean>;
  hasSessionSync(name: string): boolean;
  ensureSession(input: EnsureSessionInput): Promise<'created' | 'exists'>;
  ensureSessionSync(input: EnsureSessionInput): 'created' | 'exists';
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
      const result = await runner(['has-session', '-t', tmuxTarget(name)], {
        timeoutMs: 2_000,
      });
      return result.code === 0;
    },

    hasSessionSync(name: string): boolean {
      return (
        runnerSync(['has-session', '-t', tmuxTarget(name)], {
          timeoutMs: 2_000,
        }).code === 0
      );
    },

    async ensureSession(input): Promise<'created' | 'exists'> {
      if (await this.hasSession(input.name)) return 'exists';
      const result = await runner(newSessionArgs(input), { timeoutMs: 10_000 });
      if (result.code !== 0) {
        throw new Error(
          `tmux new-session failed (${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      return 'created';
    },

    ensureSessionSync(input): 'created' | 'exists' {
      if (this.hasSessionSync(input.name)) return 'exists';
      const result = runnerSync(newSessionArgs(input), { timeoutMs: 10_000 });
      if (result.code !== 0) {
        throw new Error(
          `tmux new-session failed (${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      return 'created';
    },

    attachArgs(name: string): { file: string; args: string[] } {
      return {
        file: 'tmux',
        args: ['attach-session', '-t', tmuxTarget(name)],
      };
    },

    async killSession(name: string): Promise<void> {
      await runner(['kill-session', '-t', tmuxTarget(name)], {
        timeoutMs: 5_000,
      });
    },

    killSessionSync(name: string): void {
      runnerSync(['kill-session', '-t', tmuxTarget(name)], {
        timeoutMs: 5_000,
      });
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

/** Test isolation for one-shot warnings. */
export function __resetPersistentSessionWarningsForTests(): void {
  warnedTmuxMissing = false;
  warnedSealedSkip = false;
  warnedSandboxSkip = false;
}

export type PersistentSpawnPlan = {
  mode: 'direct' | 'tmux';
  file: string;
  args: string[];
  tmuxName?: string;
  /** True when an existing tmux session was reattached (cold reopen). */
  reattached?: boolean;
};

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
  env?: Readonly<Record<string, string>>;
  sealedNative: boolean;
  /**
   * True when Seatbelt/Bubblewrap already rewrote the spawn (advisory or
   * governed outer-process). tmux attach would let the operator open an
   * unsandboxed shell inside the same session — refuse the wrap.
   */
  processSandboxActive?: boolean;
  backend?: PersistentSessionBackend;
  /** Called when a named session is missing so callers can drop stale registry. */
  onMissingSession?: (tmuxName: string) => void;
}): PersistentSpawnPlan {
  const direct = (): PersistentSpawnPlan => ({
    mode: 'direct',
    file: input.file,
    args: [...input.args],
  });

  if (!input.enabled || !input.paneId || !input.workspaceId) {
    return direct();
  }
  if (input.sealedNative) {
    if (!warnedSealedSkip) {
      warnedSealedSkip = true;
      console.info(
        '[pty] persistentSession skipped for native-sealed launch ' +
          '(Darwin authenticity binds the CLI binary; tmux wrap stays off)',
      );
    }
    return direct();
  }
  if (input.processSandboxActive) {
    if (!warnedSandboxSkip) {
      warnedSandboxSkip = true;
      console.info(
        '[pty] persistentSession skipped for process-sandboxed launch ' +
          '(tmux attach would bypass Seatbelt/Bubblewrap confinement)',
      );
    }
    return direct();
  }

  const backend = input.backend ?? getPersistentSessionBackend();
  if (!backend.probeAvailableSync()) {
    if (!warnedTmuxMissing) {
      warnedTmuxMissing = true;
      console.warn(
        '[pty] persistentSession unavailable: tmux missing — using direct PTY',
      );
    }
    return direct();
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
        reattached: true,
      };
    }
    input.onMissingSession?.(name);
    backend.ensureSessionSync({
      name,
      cwd: input.cwd,
      command: input.file,
      args: input.args,
      env: input.env,
    });
    const attach = backend.attachArgs(name);
    return {
      mode: 'tmux',
      file: attach.file,
      args: attach.args,
      tmuxName: name,
      reattached: false,
    };
  } catch (err) {
    console.warn(
      '[pty] persistentSession fallback to direct spawn:',
      err instanceof Error ? err.message : err,
    );
    return direct();
  }
}
