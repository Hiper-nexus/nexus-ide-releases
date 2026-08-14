import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type {
  RemoteCliDetection,
  RemoteSpawnRequest,
  RemoteSpawnResult,
  RemoteTmuxSession,
} from '../../shared/remote-types';
import { redactSshEndpoint } from './ssh/ssh-alias';
import { assertKnownSpawnAlias } from './ssh/ssh-bootstrap';
import { listKnownSshAliases } from './ssh/ssh-host-registry';

const execFileAsync = promisify(execFile);

const ALLOWED_CLIS = ['claude', 'codex', 'agy', 'kimi'] as const;
const TARGET_RE = /^[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?(?::[0-9]{2,5})?$/;
const SESSION_RE = /^[a-zA-Z0-9_.-]{1,80}$/;
const SSH_ENV_KEYS = [
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK',
  'TERM',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const;
const DEFAULT_EXEC_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const CREATED_MARKER = 'NEXUS_REMOTE_TMUX_CREATED';
const ADOPTED_MARKER = 'NEXUS_REMOTE_TMUX_ADOPTED';
const CLEANED_MARKER = 'NEXUS_REMOTE_TMUX_CLEANED';

export interface RemoteSpawnControl {
  /** Cancels in-flight SSH when the originating MCP authority is revoked. */
  readonly signal?: AbortSignal;
  /** Synchronous main-owned authority revalidation at effect boundaries. */
  readonly assertCurrentAuthority?: () => void;
}

async function validateTarget(target: string): Promise<string> {
  const clean = target.trim();
  // A value beginning with '-' would be parsed by ssh as an OPTION (e.g.
  // `-Jattacker.host` injects a jump proxy), not a host. The charset also
  // permits a leading dash, so reject it explicitly before it reaches argv.
  if (clean.startsWith('-')) throw new Error('invalid ssh target');
  if (!TARGET_RE.test(clean)) throw new Error('invalid ssh target');
  const aliases = await listKnownSshAliases();
  return assertKnownSpawnAlias(clean, aliases);
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sessionName(input?: string): string {
  if (input?.trim()) {
    const clean = input.trim();
    if (!SESSION_RE.test(clean)) throw new Error('invalid tmux session name');
    return clean;
  }
  return `nexus-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function sanitizedSshEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SSH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH ||= DEFAULT_EXEC_PATH;
  return env;
}

function assertRemoteSpawnAuthority(control?: RemoteSpawnControl): void {
  control?.assertCurrentAuthority?.();
  if (!control?.signal?.aborted) return;
  const reason = control.signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(
    typeof reason === 'string' && reason.length > 0
      ? reason
      : 'session_authority_revoked',
  );
}

function authorityFailure(
  control: RemoteSpawnControl | undefined,
): Error | null {
  try {
    assertRemoteSpawnAuthority(control);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
  );
}

async function ssh(
  target: string,
  script: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync(
    'ssh',
    // `--` ends option parsing so the target can never be read as a flag.
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', target, 'sh', '-lc', script],
    {
      timeout: 20_000,
      maxBuffer: 512_000,
      env: sanitizedSshEnvironment(process.env),
      ...(signal ? { signal } : {}),
    },
  );
  return result.stdout;
}

async function cleanupExactRemoteTmuxSession(
  target: string,
  name: string,
  spawnToken: string,
): Promise<boolean> {
  const currentToken =
    `$(tmux show-options -v -t ${quoteSh(name)} ` +
    `@nexus_spawn_token 2>/dev/null || true)`;
  const cleanup = [
    `if [ ${quoteSh(spawnToken)} = "${currentToken}" ]; then`,
    `tmux kill-session -t ${quoteSh(name)} >/dev/null 2>&1 &&`,
    `! tmux has-session -t ${quoteSh(name)} 2>/dev/null &&`,
    `printf '%s\\n' ${quoteSh(CLEANED_MARKER)};`,
    'else',
    `printf '%s\\n' ${quoteSh('NEXUS_REMOTE_TMUX_NOT_OWNED')};`,
    'fi',
  ].join(' ');
  try {
    return (await ssh(target, cleanup)).includes(CLEANED_MARKER);
  } catch {
    return false;
  }
}

export async function detectRemoteClis(
  targetRaw: string,
  control?: RemoteSpawnControl,
): Promise<RemoteCliDetection> {
  const target = await validateTarget(targetRaw);
  try {
    assertRemoteSpawnAuthority(control);
    const script = ALLOWED_CLIS
      .map((cli) => `command -v ${cli} >/dev/null 2>&1 && printf '%s\t%s\\n' ${quoteSh(cli)} "$(command -v ${cli})"`)
      .join('; ');
    const out = await ssh(target, script, control?.signal);
    assertRemoteSpawnAuthority(control);
    return {
      target,
      found: out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [cli, foundPath] = line.split('\t');
          return { cli, path: foundPath };
        })
        .filter((row) => ALLOWED_CLIS.includes(row.cli as RemoteSpawnRequest['cli'])),
    };
  } catch (err) {
    const revoked = authorityFailure(control);
    if (revoked) throw revoked;
    return {
      target,
      found: [],
      error: redactSshEndpoint(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function listRemoteTmuxSessions(
  targetRaw: string,
  control?: RemoteSpawnControl,
): Promise<RemoteSpawnResult> {
  const target = await validateTarget(targetRaw);
  try {
    assertRemoteSpawnAuthority(control);
    const out = await ssh(
      target,
      "tmux list-sessions -F '#{session_name}\\t#{session_windows}\\t#{session_created}\\t#{session_attached}' 2>/dev/null || true",
      control?.signal,
    );
    assertRemoteSpawnAuthority(control);
    const sessions: RemoteTmuxSession[] = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, windows, created, attached] = line.split('\t');
        return {
          name,
          windows: Number(windows) || 0,
          createdAt: Number(created) ? Number(created) * 1000 : undefined,
          attached: attached === '1',
        };
      });
    return { ok: true, target, sessions };
  } catch (err) {
    const revoked = authorityFailure(control);
    if (revoked) throw revoked;
    return {
      ok: false,
      target,
      error: redactSshEndpoint(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function createRemoteTmuxSession(
  req: RemoteSpawnRequest,
  control?: RemoteSpawnControl,
): Promise<RemoteSpawnResult> {
  const target = await validateTarget(req.target);
  if (!ALLOWED_CLIS.includes(req.cli)) throw new Error('unsupported remote cli');
  const name = sessionName(req.sessionName);
  const cwd = req.cwd?.trim();
  const spawnToken = randomBytes(24).toString('hex');
  const start = [
    `if tmux has-session -t ${quoteSh(name)} 2>/dev/null; then`,
    `printf '%s\\n' ${quoteSh(ADOPTED_MARKER)};`,
    'else',
    `if tmux new-session -d -s ${quoteSh(name)} ` +
      `${cwd ? `-c ${quoteSh(cwd)} ` : ''}${quoteSh(req.cli)}; then`,
    `if tmux set-option -t ${quoteSh(name)} ` +
      `@nexus_spawn_token ${quoteSh(spawnToken)}; then`,
    `printf '%s\\n' ${quoteSh(CREATED_MARKER)};`,
    'else',
    `tmux kill-session -t ${quoteSh(name)} >/dev/null 2>&1 || true;`,
    'exit 1;',
    'fi;',
    'else',
    'exit 1;',
    'fi;',
    'fi',
  ].join(' ');
  const promptScript = req.prompt?.trim()
    ? `tmux send-keys -t ${quoteSh(name)} ${quoteSh(req.prompt)} C-m`
    : '';
  let creationStarted = false;
  let created = false;
  let adopted = false;
  let promptStarted = false;
  try {
    assertRemoteSpawnAuthority(control);
    creationStarted = true;
    const startOutput = await ssh(target, start, control?.signal);
    created = startOutput.includes(CREATED_MARKER);
    adopted = startOutput.includes(ADOPTED_MARKER);
    if (created === adopted) {
      throw new Error('remote tmux creation acknowledgement is invalid');
    }
    assertRemoteSpawnAuthority(control);
    if (promptScript) {
      // Separate prompt delivery from creation so revocation can stop the
      // second effect and a newly-created session can be cleaned exactly.
      assertRemoteSpawnAuthority(control);
      promptStarted = true;
      await ssh(target, promptScript, control?.signal);
      assertRemoteSpawnAuthority(control);
    }
    return {
      ok: true,
      target,
      sessionName: name,
      attachCommand: `ssh -t ${target} tmux attach -t ${name}`,
    };
  } catch (err) {
    const revoked =
      authorityFailure(control) ??
      (isAbortError(err)
        ? err instanceof Error
          ? err
          : new Error('session_authority_revoked')
        : null);
    let cleaned = false;
    if (creationStarted && !adopted) {
      cleaned = await cleanupExactRemoteTmuxSession(
        target,
        name,
        spawnToken,
      );
    }
    if (revoked) {
      if (!creationStarted) throw revoked;
      if (created && cleaned && !promptStarted) throw revoked;
      if (adopted && !promptStarted) throw revoked;
      const uncertainty = adopted
        ? 'prompt delivery to an adopted remote session could not be undone'
        : promptStarted
          ? 'prompt delivery outcome was not proven'
          : 'remote tmux creation outcome or exact cleanup was not proven';
      throw new Error(
        `${revoked.message}; effectMayHaveCommitted: ${uncertainty}`,
        { cause: err },
      );
    }
    const effectUncertain =
      promptStarted ||
      (creationStarted && !adopted && !cleaned);
    if (effectUncertain) {
      const uncertainty = promptStarted
        ? 'prompt delivery outcome was not proven'
        : 'remote tmux creation outcome or exact cleanup was not proven';
      return {
        ok: false,
        target,
        sessionName: name,
        error: redactSshEndpoint(
          `${err instanceof Error ? err.message : String(err)}; ` +
            `effectMayHaveCommitted: ${uncertainty}`,
        ),
      };
    }
    return {
      ok: false,
      target,
      sessionName: name,
      error: redactSshEndpoint(err instanceof Error ? err.message : String(err)),
    };
  }
}
