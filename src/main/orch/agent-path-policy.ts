import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Read policy for AGENT-facing file tools (M2 mitigation).
 *
 * The workspace `.nexus/` tree holds app metadata that includes real secrets —
 * notably `mcp-hub.json`, which persists third-party MCP server tokens/API keys
 * in cleartext so the hub can launch them. Those secrets are legitimately read
 * by the hub launcher (a different, internal code path), but a prompt-injected
 * agent must not be able to `nexus_file_read` / `content_audit` / `editor_open`
 * them and exfiltrate them into its model context.
 *
 * This denylist is applied ONLY in the agent tool layer — internal context
 * indexing keeps its full read access. Kept deliberately tight (secret-bearing
 * files only) so ordinary agent reads never break.
 */

const DENIED_EXACT = new Set<string>([
  '.nexus/mcp-hub.json',
  '.nexus/mcp-hub.json.bak',
]);

// Secret-bearing files anywhere under the workspace `.nexus/` metadata tree.
const DENIED_PATTERNS: RegExp[] = [
  /^\.nexus\/secrets(\.enc)?$/i,
  /^\.nexus\/.*\.(?:secret|credentials?|key|pem)$/i,
  /^\.nexus\/mcp-hub\.json(\.[0-9a-z.-]+)?$/i,
];

/** Normalize a workspace-relative path to a comparable POSIX form. */
function normalizeRelative(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, '/');
  const normalized = path.posix
    .normalize(posix)
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  return normalized;
}

/** True when an agent tool must NOT read this workspace-relative path. */
export function isAgentDeniedReadPath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).toLowerCase();
  if (DENIED_EXACT.has(normalized)) return true;
  return DENIED_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Throws if an agent tool tries to read a secret-bearing workspace path.
 *
 * The check runs on the RESOLVED, root-relative path — not the raw argument —
 * so it cannot be bypassed with an absolute path (`/…/.nexus/mcp-hub.json`) or a
 * re-entrant `../<workspace-name>/.nexus/mcp-hub.json` that resolves back inside
 * the root. Inputs that escape the workspace are left to the reader (which fails
 * closed on them).
 */
export function assertAgentReadablePath(
  scope: ProjectExecutionScope,
  relativePath: string,
): void {
  // Lexically resolve the argument the same way the file reader does — absolute
  // paths anchor on themselves, relative ones anchor on the root — then compute
  // the root-relative form. This is a pure check (the reader still enforces
  // realpath/symlink confinement); it exists only to catch secret-path reads
  // whether addressed relatively, absolutely, or via a re-entrant `..`.
  const root = path.resolve(scope.rootRealPath);
  const resolved = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(root, relativePath);
  const rootRelative = path.relative(root, resolved);
  // Escapes the workspace — the reader rejects it; not a secret-path concern.
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) return;
  if (isAgentDeniedReadPath(rootRelative)) {
    throw new Error(
      `access denied: '${relativePath}' holds credentials and is not readable by agent tools`,
    );
  }
}
