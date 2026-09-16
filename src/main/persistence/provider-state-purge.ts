import fs from 'node:fs';
import path from 'node:path';

/**
 * Removes `<userData>/provider-state/<adapter>/<checkoutId>` across every
 * adapter for one checkout (F-570). This directory tree holds durable
 * conversation history and auth links (see linkProviderSessionState in
 * cli-mcp-session-artifacts.ts) that otherwise never gets cleaned up — not
 * even when the checkout itself is gone.
 *
 * Never age-based: conversation history is user data, so the only trigger is
 * an explicit checkout/workspace removal the caller has already confirmed.
 * Best-effort per adapter: a failure on one adapter never blocks the others,
 * and checkoutId is validated as a bare identifier (no path separators, no
 * traversal) before it is ever joined into a filesystem path.
 */

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export interface ProviderStatePurgeResult {
  readonly removedAdapters: readonly string[];
  readonly failedAdapters: readonly string[];
}

function removeCheckoutDirectory(candidate: string): 'removed' | 'absent' | 'failed' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed';
  }
  // A symlinked checkout directory is never Nexus's own layout; refuse it
  // rather than follow it into an arbitrary target.
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'failed';
  try {
    fs.rmSync(candidate, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 10,
    });
    return 'removed';
  } catch {
    return 'failed';
  }
}

export function purgeProviderStateForCheckout(
  userDataPath: string,
  checkoutId: string,
): ProviderStatePurgeResult {
  const removedAdapters: string[] = [];
  const failedAdapters: string[] = [];
  if (!IDENTIFIER_PATTERN.test(checkoutId)) {
    return { removedAdapters, failedAdapters };
  }
  const providerStateRoot = path.join(userDataPath, 'provider-state');
  let adapterEntries: fs.Dirent[];
  try {
    adapterEntries = fs.readdirSync(providerStateRoot, { withFileTypes: true });
  } catch {
    return { removedAdapters, failedAdapters };
  }
  for (const entry of adapterEntries) {
    if (!entry.isDirectory() || !IDENTIFIER_PATTERN.test(entry.name)) continue;
    const outcome = removeCheckoutDirectory(
      path.join(providerStateRoot, entry.name, checkoutId),
    );
    if (outcome === 'removed') removedAdapters.push(entry.name);
    else if (outcome === 'failed') failedAdapters.push(entry.name);
  }
  return { removedAdapters, failedAdapters };
}
