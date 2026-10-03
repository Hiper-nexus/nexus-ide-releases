import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { probeQwenCredential, type QwenReadinessResult } from './qwen-readiness';
import { qwenSettingsPath } from './qwen-settings';

const FRESH_MS = 5 * 60_000;
interface RefreshOptions { key?: string | null; home?: string; force?: boolean; onChange?: () => void }

/** One physical probe. Persistent fields contain only verdicts, times and opaque digests. */
export class QwenReadinessCache {
  private result: QwenReadinessResult = { state: 'unknown' };
  private identity: string | null = null;
  private inputIdentity: string | null = null;
  private checkedAt = 0;
  private epoch = 0;
  private stopped = false;
  private flight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchedFile = '';
  private onChange: (() => void) | undefined;
  constructor(private readonly probe = probeQwenCredential, private readonly watchConfig = true) {}

  snapshot(): QwenReadinessResult { return this.result; }
  invalidate(): void {
    this.epoch++;
    this.controller?.abort();
    this.checkedAt = 0;
    this.identity = null;
    this.result = Object.freeze({ state: 'unknown' });
  }
  request(options: RefreshOptions = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (typeof options.key === 'string' && options.key.length > 8192) { this.invalidate(); return Promise.resolve(); }
    this.onChange = options.onChange ?? this.onChange;
    const file = qwenSettingsPath(options.home);
    const inputIdentity = createHash('sha256').update(JSON.stringify([options.key ?? null, file])).digest('hex');
    const changed = this.inputIdentity !== inputIdentity;
    if (changed) { this.invalidate(); this.inputIdentity = inputIdentity; }
    this.ensureWatch(file);
    if (this.flight) return this.flight.then(() => changed && options.force ? this.request(options) : undefined);
    if (!options.force && this.checkedAt && Date.now() - this.checkedAt < FRESH_MS) return Promise.resolve();
    const epoch = this.epoch;
    const controller = new AbortController(); this.controller = controller;
    let identity: string | null = null;
    const flight = this.probe({ key: options.key, home: options.home, signal: controller.signal,
      onIdentity: value => { identity = value; },
    }).then(result => {
      if (epoch !== this.epoch || this.stopped) return;
      // An outage cannot refute a rejection for the very same credential.
      const preserveRejection = identity === this.identity && result.state === 'unknown' && this.result.state === 'invalid-credential';
      if (!preserveRejection) this.result = Object.freeze({ ...result });
      this.identity = identity;
      this.checkedAt = Date.now();
    }).catch(() => { if (epoch === this.epoch) this.checkedAt = Date.now(); }).finally(() => {
      if (this.flight === flight) { this.flight = null; this.controller = null; }
      if (!this.stopped) { try { this.onChange?.(); } catch { /* Snapshot consumers cannot break probe ownership. */ } }
    });
    this.flight = flight;
    return flight;
  }
  private ensureWatch(file: string): void {
    if (!this.watchConfig || this.watchedFile === file && this.watcher) return;
    this.watcher?.close(); this.watcher = null; this.watchedFile = file;
    try {
      const watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (this.stopped || this.watcher !== watcher || name && name.toString() !== path.basename(file)) return;
        this.invalidate();
        try { this.onChange?.(); } catch { /* Best effort refresh. */ }
      });
      this.watcher = watcher;
      watcher.on('error', () => { if (this.watcher === watcher) { watcher.close(); this.watcher = null; this.invalidate(); } });
      watcher.unref();
    } catch { /* Missing profile directory: the next request retries the watch. */ }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.invalidate();
    this.watcher?.close(); this.watcher = null;
    await this.flight;
  }
}

const qwenReadiness = new QwenReadinessCache();
export const peekQwenReadiness = () => qwenReadiness.snapshot();
export const invalidateQwenReadiness = () => qwenReadiness.invalidate();
export const requestQwenReadiness = (options: RefreshOptions = {}) => qwenReadiness.request(options);
export const stopQwenReadiness = () => qwenReadiness.stop();
export async function verifyQwenReadiness(key?: string | null): Promise<QwenReadinessResult> {
  await qwenReadiness.request({ key, force: true });
  return qwenReadiness.snapshot();
}
