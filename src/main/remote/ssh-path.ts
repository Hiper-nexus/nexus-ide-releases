// Adapted from stablyai/orca SSH path normalization patterns @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure path helpers only;
// no agent force; git/fs ops stay behind authorized remote capability; root '/'
// containment uses prefix-safe rules (not startsWith('//')).

/** Normalize remote POSIX path for SSH filesystem/git. */
export function normalizeSshRemotePath(input: string): string {
  if (!input) return '/';
  const withSlash = input.startsWith('/') ? input : `/${input}`;
  const parts = withSlash.split('/').filter((p) => p && p !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? '/' : `/${out.join('/')}`;
}

/**
 * Reject path traversal that escapes a remote project root.
 * When root is `/`, every absolute path under the remote FS is inside root
 * except we still reject `..` escapes via normalization.
 */
export function resolveSshPathInsideRoot(root: string, relative: string): string | null {
  const base = normalizeSshRemotePath(root);
  const joined =
    relative.startsWith('/')
      ? relative
      : base === '/'
        ? `/${relative}`
        : `${base}/${relative}`;
  const target = normalizeSshRemotePath(joined);
  if (base === '/') {
    // Entire remote absolute namespace is inside root once normalized.
    return target.startsWith('/') ? target : null;
  }
  if (target === base) return target;
  if (!target.startsWith(`${base}/`)) return null;
  return target;
}
