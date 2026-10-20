import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

/**
 * Process lifetime of the video engine (F-1594): render, install and export
 * run as Main-owned children — no shell, hidden window, allowlisted env —
 * and cancelling kills the WHOLE tree. A render is a Node CLI that launches
 * several headless Chrome workers and ffmpeg; killing only the root leaves
 * Chrome orphans holding RAM. Windows: `taskkill /T /F`; POSIX: the process
 * group (the child is its leader). After the tree is gone, any process that
 * still runs from the engine folder is an orphan of a crash and is swept.
 */

export interface OwnedProcessOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface OwnedProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Last lines of output (stdout and stderr interleaved), each ≤ 2.000 chars. */
  readonly tail: readonly string[];
  readonly spawnError?: string;
}

export interface ProcessPorts {
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  killTree(pid: number): Promise<void>;
  platform: NodeJS.Platform;
}

const TAIL_LINES = 200;
const MAX_LINE_CHARS = 2_000;
const POSIX_TERM_GRACE_MS = 3_000;

function taskkillPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kill a process and every descendant. Resolves when the tree is gone (or was already). */
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile(
        taskkillPath(),
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true, shell: false, timeout: 15_000 },
        // 128 = already exited; anything else still leaves the sweep as backstop.
        () => resolve(),
      );
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // group already gone
  }
  const deadline = Date.now() + POSIX_TERM_GRACE_MS;
  while (Date.now() < deadline && groupAlive(pid)) await waitMs(100);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone between the check and the kill
    }
  }
}

const productionPorts: ProcessPorts = {
  spawn: (file, args, options) => spawn(file, [...args], options),
  killTree: (pid) => killProcessTree(pid),
  platform: process.platform,
};

export function runOwnedProcess(
  options: OwnedProcessOptions,
  ports: ProcessPorts = productionPorts,
): Promise<OwnedProcessResult> {
  return new Promise((resolve) => {
    const tail: string[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killing: Promise<void> | null = null;
    const pushLine = (raw: string, stream: 'stdout' | 'stderr') => {
      const line = raw.replace(/\r$/u, '').slice(0, MAX_LINE_CHARS);
      if (!line) return;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      options.onLine?.(line, stream);
    };

    let child: ChildProcess;
    try {
      child = ports.spawn(options.file, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        // POSIX: own process group, so the whole tree can be signalled.
        detached: ports.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, aborted: false, tail, spawnError: (error as Error).message });
      return;
    }

    const stop = () => {
      if (killing || child.pid === undefined) return;
      killing = ports.killTree(child.pid);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, options.timeoutMs));
    timer.unref?.();

    for (const stream of ['stdout', 'stderr'] as const) {
      let pending = '';
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) pushLine(line, stream);
        if (pending.length > MAX_LINE_CHARS * 4) {
          pushLine(pending, stream);
          pending = '';
        }
      });
      child[stream]?.on('end', () => {
        if (pending) pushLine(pending, stream);
        pending = '';
      });
    }

    const finish = async (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // A cancelled tree is only "gone" once the kill finished.
      if (killing) await killing;
      resolve({
        exitCode: timedOut || aborted ? null : exitCode,
        timedOut,
        aborted: aborted && !timedOut,
        tail,
        ...(spawnError ? { spawnError } : {}),
      });
    };
    child.once('error', (error) => {
      if (child.pid === undefined) void finish(null, error.message);
    });
    child.once('close', (code) => void finish(code));
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * PIDs of processes whose executable lives under `folder` (the engine's own
 * Chrome). Windows: CIM via Windows PowerShell; POSIX: `ps`. The folder goes
 * through the environment, never into the command text.
 */
export function listProcessesUnder(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number[]> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      const root = process.env.SystemRoot ?? 'C:\\Windows';
      const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script =
        '$p = $env:NEXUS_VIDEO_ENGINE_DIR; ' +
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
        '$_.ExecutablePath.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
        'ForEach-Object { $_.ProcessId }';
      execFile(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          env: { SystemRoot: root, NEXUS_VIDEO_ENGINE_DIR: folder },
          windowsHide: true,
          shell: false,
          timeout: 20_000,
        },
        (error, stdout) => {
          if (error) return resolve([]);
          resolve(
            String(stdout)
              .split(/\r?\n/u)
              .map((line) => Number(line.trim()))
              .filter((pid) => Number.isInteger(pid) && pid > 0),
          );
        },
      );
      return;
    }
    execFile('/bin/ps', ['-axo', 'pid=,args='], { timeout: 10_000, shell: false }, (error, stdout) => {
      if (error) return resolve([]);
      const pids: number[] = [];
      for (const line of String(stdout).split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
        if (match && match[2].startsWith(folder)) pids.push(Number(match[1]));
      }
      resolve(pids);
    });
  });
}

/** Kill leftovers running from the engine folder; returns how many were found. */
export async function sweepEngineOrphans(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const pids = await listProcessesUnder(folder, platform);
  for (const pid of pids) {
    if (platform === 'win32') {
      await new Promise<void>((resolve) =>
        execFile(taskkillPath(), ['/pid', String(pid), '/F'], { windowsHide: true, shell: false, timeout: 10_000 }, () =>
          resolve(),
        ),
      );
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  return pids.length;
}
