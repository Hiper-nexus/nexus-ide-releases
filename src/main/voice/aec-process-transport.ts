import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import type { AecHelperTransport } from './aec-helper-client';

/** Spawn boundary for packaged AEC helpers. No shell, inherited environment is
 * minimized, stderr is diagnostic-only and stdout is protocol-only. */
export function spawnAecHelper(helperPath: string): AecHelperTransport {
  const stat = fs.statSync(helperPath);
  if (!stat.isFile()) throw new Error('AEC helper path is not a regular file');
  const child: ChildProcessWithoutNullStreams = spawn(helperPath, [], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      HOME: process.env.HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      PIPEWIRE_RUNTIME_DIR: process.env.PIPEWIRE_RUNTIME_DIR,
      PULSE_SERVER: process.env.PULSE_SERVER,
      LANG: process.env.LANG,
    },
  });
  child.stderr.on('data', (chunk) => {
    const line = String(chunk).replace(/[^\x20-\x7e\n]/g, '').trim().slice(0, 500);
    if (line) console.warn(`[aec-helper] ${line}`);
  });
  return {
    write: (data) => child.stdin.writable && child.stdin.write(data),
    close: () => {
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
    },
    onData: (listener) => {
      child.stdout.on('data', listener);
      return () => child.stdout.off('data', listener);
    },
    onExit: (listener) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        listener(code === 0 ? undefined : new Error(`AEC helper exited code=${code} signal=${signal}`));
      child.on('exit', onExit);
      return () => child.off('exit', onExit);
    },
  };
}
