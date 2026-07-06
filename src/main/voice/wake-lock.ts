import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Mutex de wake word entre instâncias (dev `npm start` + app empacotado
 * abertos juntos): sem isto, AMBAS respondem ao "Hey Jarvis" — duas vozes,
 * dois turnos, mic disputado. Um lockfile com PID em ~/.nexus decide quem é a
 * dona do wake; a outra instância ignora os frames em silêncio.
 *
 * PID morto (ESRCH) = lock órfão → pode ser roubado. EPERM conta como vivo.
 */

const DEFAULT_LOCK_FILE = path.join(os.homedir(), '.nexus', 'jarvis-wake.lock');

export interface WakeLockDeps {
  readFile: (file: string) => string;
  writeFile: (file: string, data: string) => void;
  removeFile: (file: string) => void;
  fileExists: (file: string) => boolean;
  isPidAlive: (pid: number) => boolean;
  ownPid: () => number;
  lockFile?: string;
}

const defaultDeps: WakeLockDeps = {
  readFile: (file) => fs.readFileSync(file, 'utf-8'),
  writeFile: (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, 'utf-8');
  },
  removeFile: (file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      // já removido
    }
  },
  fileExists: (file) => fs.existsSync(file),
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = existe mas não é nosso → vivo. Só ESRCH é morto de verdade.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  ownPid: () => process.pid,
};

function lockPath(deps: WakeLockDeps): string {
  return deps.lockFile ?? DEFAULT_LOCK_FILE;
}

function readLockPid(deps: WakeLockDeps): number | null {
  const file = lockPath(deps);
  if (!deps.fileExists(file)) return null;
  try {
    const pid = Number.parseInt(deps.readFile(file).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Tenta virar a dona do wake. true = somos a dona (lock nosso ou roubado de
 * um PID morto); false = outra instância VIVA já detém o wake.
 */
export function acquireWakeLock(deps: WakeLockDeps = defaultDeps): boolean {
  const holder = readLockPid(deps);
  const me = deps.ownPid();
  if (holder === me) return true;
  if (holder !== null && deps.isPidAlive(holder)) return false;
  try {
    deps.writeFile(lockPath(deps), String(me));
    return true;
  } catch {
    return false;
  }
}

/** Solta o lock se for nosso (chamar no quit / wake desligado). */
export function releaseWakeLock(deps: WakeLockDeps = defaultDeps): void {
  const holder = readLockPid(deps);
  if (holder === deps.ownPid()) deps.removeFile(lockPath(deps));
}

/** PID vivo de outra instância detendo o wake (null = livre ou nosso). */
export function wakeLockHolder(deps: WakeLockDeps = defaultDeps): number | null {
  const holder = readLockPid(deps);
  if (holder === null || holder === deps.ownPid()) return null;
  return deps.isPidAlive(holder) ? holder : null;
}
