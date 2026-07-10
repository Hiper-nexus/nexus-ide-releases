import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type {
  RemoteCliDetection,
  RemoteSpawnRequest,
  RemoteSpawnResult,
  RemoteTmuxSession,
} from '../../shared/remote-types';

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

function validateTarget(target: string): string {
  const clean = target.trim();
  // A value beginning with '-' would be parsed by ssh as an OPTION (e.g.
  // `-Jattacker.host` injects a jump proxy), not a host. The charset also
  // permits a leading dash, so reject it explicitly before it reaches argv.
  if (clean.startsWith('-')) throw new Error('invalid ssh target');
  if (!TARGET_RE.test(clean)) throw new Error('invalid ssh target');
  return clean;
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

async function ssh(target: string, script: string): Promise<string> {
  const result = await execFileAsync(
    'ssh',
    // `--` ends option parsing so the target can never be read as a flag.
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', target, 'sh', '-lc', script],
    {
      timeout: 20_000,
      maxBuffer: 512_000,
      env: sanitizedSshEnvironment(process.env),
    },
  );
  return result.stdout;
}

export async function detectRemoteClis(targetRaw: string): Promise<RemoteCliDetection> {
  const target = validateTarget(targetRaw);
  try {
    const script = ALLOWED_CLIS
      .map((cli) => `command -v ${cli} >/dev/null 2>&1 && printf '%s\t%s\\n' ${quoteSh(cli)} "$(command -v ${cli})"`)
      .join('; ');
    const out = await ssh(target, script);
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
    return {
      target,
      found: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listRemoteTmuxSessions(targetRaw: string): Promise<RemoteSpawnResult> {
  const target = validateTarget(targetRaw);
  try {
    const out = await ssh(
      target,
      "tmux list-sessions -F '#{session_name}\\t#{session_windows}\\t#{session_created}\\t#{session_attached}' 2>/dev/null || true",
    );
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
    return {
      ok: false,
      target,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function createRemoteTmuxSession(
  req: RemoteSpawnRequest,
): Promise<RemoteSpawnResult> {
  const target = validateTarget(req.target);
  if (!ALLOWED_CLIS.includes(req.cli)) throw new Error('unsupported remote cli');
  const name = sessionName(req.sessionName);
  const cwd = req.cwd?.trim();
  const start = `tmux has-session -t ${quoteSh(name)} 2>/dev/null || tmux new-session -d -s ${quoteSh(name)} ${cwd ? `-c ${quoteSh(cwd)}` : ''} ${quoteSh(req.cli)}`;
  const prompt = req.prompt?.trim()
    ? `tmux send-keys -t ${quoteSh(name)} ${quoteSh(req.prompt)} C-m`
    : '';
  try {
    await ssh(target, [start, prompt].filter(Boolean).join('; '));
    return {
      ok: true,
      target,
      sessionName: name,
      attachCommand: `ssh -t ${target} tmux attach -t ${name}`,
    };
  } catch (err) {
    return {
      ok: false,
      target,
      sessionName: name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
