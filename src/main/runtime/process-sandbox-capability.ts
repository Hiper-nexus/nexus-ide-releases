import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * True when the host can actually *run* a process under the production
 * sandbox provider (Seatbelt on macOS, Bubblewrap on Linux). GitHub-hosted
 * Linux runners install `bwrap` but often deny nested user-namespace uid maps
 * (`setting up uid map: Permission denied`), so binary presence alone is not
 * enough for integration tests that exec through the sandbox.
 */
export function processSandboxRuntimeAvailable(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/usr/bin/sandbox-exec');
  }
  if (process.platform === 'win32') {
    const runtime = process.env.NEXUS_SANDBOX_CONTAINER_RUNTIME?.trim();
    const image = process.env.NEXUS_SANDBOX_CONTAINER_IMAGE?.trim();
    if (!runtime || !image || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/i.test(image)) {
      return false;
    }
    try {
      execFileSync(runtime, ['image', 'inspect', image], {
        timeout: 10_000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform !== 'linux') return false;

  let bwrap: string | null = null;
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      bwrap = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!bwrap) return false;

  try {
    execFileSync(
      bwrap,
      [
        '--die-with-parent',
        '--unshare-all',
        '--share-net',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--',
        '/usr/bin/true',
      ],
      { timeout: 5_000, stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}
