import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SESSION_ALIVE_FILE = 'session.alive.v1.json';
export const SESSION_ALIVE_SCHEME_VERSION = 1;

export interface SessionAliveMarker {
  schemeVersion: 1;
  pid: number;
  startTime: number;
  lastPulse: number;
  rssMb: number;
  activePanes: number;
  expectedExit: boolean;
}

export function bucketRssMb(bytes: number): number {
  const mb = bytes / (1024 * 1024);
  return Math.max(10, Math.round(mb / 10) * 10);
}

export function readSessionAliveMarker(
  userDataPath: string,
): SessionAliveMarker | null {
  const filePath = path.join(userDataPath, SESSION_ALIVE_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.schemeVersion !== SESSION_ALIVE_SCHEME_VERSION) return null;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startTime !== 'number' ||
      typeof parsed.lastPulse !== 'number' ||
      typeof parsed.rssMb !== 'number' ||
      typeof parsed.activePanes !== 'number' ||
      typeof parsed.expectedExit !== 'boolean'
    ) {
      return null;
    }
    return parsed as SessionAliveMarker;
  } catch {
    return null;
  }
}

export function writeSessionAliveMarker(
  userDataPath: string,
  marker: SessionAliveMarker,
): void {
  fs.mkdirSync(userDataPath, { recursive: true });
  const finalPath = path.join(userDataPath, SESSION_ALIVE_FILE);
  const tmpPath = path.join(
    userDataPath,
    `.${SESSION_ALIVE_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    if (process.platform === 'win32') {
      try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.renameSync(tmpPath, finalPath);
      } catch {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw err;
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }
}

export interface SessionSentinelOptions {
  userDataPath: string;
  intervalMs?: number;
  getActivePanes?: () => number;
  onPriorCrashDetected?: (prior: SessionAliveMarker) => void;
}

export class SessionAliveSentinel {
  readonly #userDataPath: string;
  readonly #intervalMs: number;
  readonly #getActivePanes: () => number;
  readonly #onPriorCrashDetected?: (prior: SessionAliveMarker) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #startTime = Date.now();
  #disposed = false;

  constructor(options: SessionSentinelOptions) {
    this.#userDataPath = options.userDataPath;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#getActivePanes = options.getActivePanes ?? (() => 0);
    this.#onPriorCrashDetected = options.onPriorCrashDetected;
  }

  start(): { priorCrash: SessionAliveMarker | null } {
    if (this.#disposed) return { priorCrash: null };

    // Inspect previous marker
    const prior = readSessionAliveMarker(this.#userDataPath);
    let priorCrash: SessionAliveMarker | null = null;
    if (prior && !prior.expectedExit) {
      priorCrash = prior;
      this.#onPriorCrashDetected?.(prior);
    }

    // Sweep orphaned temp files from abnormal process exits
    try {
      if (fs.existsSync(this.#userDataPath)) {
        const files = fs.readdirSync(this.#userDataPath);
        for (const f of files) {
          if (f.startsWith(`.${SESSION_ALIVE_FILE}.`) && f.endsWith('.tmp')) {
            try {
              fs.unlinkSync(path.join(this.#userDataPath, f));
            } catch {}
          }
        }
      }
    } catch {}

    this.#startTime = Date.now();
    this.pulse();

    this.#timer = setInterval(() => {
      this.pulse();
    }, this.#intervalMs);

    return { priorCrash };
  }

  pulse(): void {
    if (this.#disposed) return;
    const mem = process.memoryUsage?.()?.rss ?? 0;
    const marker: SessionAliveMarker = {
      schemeVersion: 1,
      pid: process.pid,
      startTime: this.#startTime,
      lastPulse: Date.now(),
      rssMb: bucketRssMb(mem),
      activePanes: this.#getActivePanes(),
      expectedExit: false,
    };
    try {
      writeSessionAliveMarker(this.#userDataPath, marker);
    } catch (err) {
      console.warn('[sentinel] failed to write session pulse:', err);
    }
  }

  markExpectedExit(): void {
    if (this.#disposed) return;
    const mem = process.memoryUsage?.()?.rss ?? 0;
    const marker: SessionAliveMarker = {
      schemeVersion: 1,
      pid: process.pid,
      startTime: this.#startTime,
      lastPulse: Date.now(),
      rssMb: bucketRssMb(mem),
      activePanes: this.#getActivePanes(),
      expectedExit: true,
    };
    try {
      writeSessionAliveMarker(this.#userDataPath, marker);
    } catch {}
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
