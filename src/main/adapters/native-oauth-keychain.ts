import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { slimClaudeCredentialBlob } from './claude-credential';

const NATIVE_OAUTH_READ_TTL_MS = 15_000;
const NATIVE_OAUTH_DENIED_BACKOFF_MS = 5 * 60_000;

type NativeOAuthCacheEntry =
  | { kind: 'value'; credential: string | null; until: number }
  | { kind: 'unavailable'; until: number };

const nativeOAuthCache = new Map<string, NativeOAuthCacheEntry>();
const nativeOAuthFlights = new Map<string, {
  promise: Promise<string | null>;
  fresh: boolean;
}>();
const nativeOAuthGenerations = new Map<string, symbol>();

export interface NativeOAuthReadOptions {
  /**
   * Ignore a cached success/miss after the CLI reported login completion.
   * A cached denial is NEVER bypassed: retrying it would reopen the macOS
   * authorization dialog in a loop.
   */
  bypassCache?: boolean;
}

export function invalidateNativeOAuthCredentialCache(service?: string): void {
  if (service === undefined) {
    nativeOAuthCache.clear();
    nativeOAuthFlights.clear();
    nativeOAuthGenerations.clear();
  } else {
    nativeOAuthCache.delete(service);
    nativeOAuthFlights.delete(service);
    nativeOAuthGenerations.delete(service);
  }
}

/** Seed after a trusted capture/write so status probes do not reread secrets. */
export function rememberNativeOAuthCredential(
  service: string,
  blob: string,
): void {
  invalidateNativeOAuthCredentialCache(service);
  const credential = slimClaudeCredentialBlob(blob);
  if (!credential) return;
  nativeOAuthCache.set(service, {
    kind: 'value',
    credential,
    until: Date.now() + NATIVE_OAUTH_READ_TTL_MS,
  });
}

/** OpenClaude uses its own service, with a hash for a non-default config home. */
export function openClaudeKeychainService(home: string, configDir?: string): string {
  const defaultDir = path.resolve(home, '.openclaude').normalize('NFC');
  const resolved = path.resolve(configDir || defaultDir).normalize('NFC');
  const suffix = resolved === defaultDir ? '' :
    `-${createHash('sha256').update(resolved).digest('hex').slice(0, 8)}`;
  return `OpenClaude-credentials${suffix}`;
}

/** Main-only bounded read; returns the slim OAuth slice and never logs it. */
export function readNativeOAuthCredential(
  service: string,
  execImpl: typeof execFile = execFile,
  options: NativeOAuthReadOptions = {},
): Promise<string | null> {
  // Custom exec implementations are test seams. Cache only the real process;
  // otherwise one fixture can poison the next with a different fake result.
  const shouldCache = execImpl === execFile;
  const held = shouldCache ? nativeOAuthCache.get(service) : undefined;
  if (
    held &&
    Date.now() < held.until &&
    (!options.bypassCache || held.kind === 'unavailable')
  ) {
    return held.kind === 'unavailable'
      ? Promise.reject(new Error('Keychain unavailable'))
      : Promise.resolve(held.credential);
  }
  const heldFlight = shouldCache ? nativeOAuthFlights.get(service) : undefined;
  if (heldFlight) {
    if (!options.bypassCache || heldFlight.fresh) return heldFlight.promise;
    // A post-login observation cannot consume a pre-login result. Wait for
    // that read, then refresh; a denial still observes the backoff above.
    const refresh = () => readNativeOAuthCredential(service, execImpl, options);
    return heldFlight.promise.then(refresh, refresh);
  }
  const generation = Symbol(service);
  if (shouldCache) {
    // While a fresh observation is pending, later callers must join it rather
    // than consume the successful credential that the login just replaced.
    if (options.bypassCache) nativeOAuthCache.delete(service);
    nativeOAuthGenerations.set(service, generation);
  }
  const canPublish = () => shouldCache && nativeOAuthGenerations.get(service) === generation;
  const pending = new Promise<string | null>((resolve, reject) => {
    execImpl('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 5_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (!error) {
        const credential = slimClaudeCredentialBlob(stdout);
        if (canPublish()) {
          nativeOAuthCache.set(service, {
            kind: 'value',
            credential,
            until: Date.now() + NATIVE_OAUTH_READ_TTL_MS,
          });
        }
        return resolve(credential);
      }
      if (error.code === 44) {
        if (canPublish()) {
          nativeOAuthCache.set(service, {
            kind: 'value',
            credential: null,
            until: Date.now() + NATIVE_OAUTH_READ_TTL_MS,
          });
        }
        return resolve(null);
      }
      if (canPublish()) {
        nativeOAuthCache.set(service, {
          kind: 'unavailable',
          until: Date.now() + NATIVE_OAUTH_DENIED_BACKOFF_MS,
        });
      }
      reject(new Error('Keychain unavailable'));
    });
  });
  if (!shouldCache) return pending;
  const flight = pending.finally(() => {
    if (!canPublish()) return;
    nativeOAuthFlights.delete(service);
    nativeOAuthGenerations.delete(service);
  });
  nativeOAuthFlights.set(service, { promise: flight, fresh: options.bypassCache === true });
  return flight;
}

export async function readNativeOAuthKeychain(
  service: string,
  execImpl: typeof execFile = execFile,
  options: NativeOAuthReadOptions = {},
): Promise<boolean> {
  return (await readNativeOAuthCredential(service, execImpl, options)) !== null;
}
