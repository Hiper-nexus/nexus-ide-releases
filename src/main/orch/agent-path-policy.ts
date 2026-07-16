import path from 'node:path';

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

/** Throws if an agent tool tries to read a secret-bearing workspace path. */
export function assertAgentReadablePath(relativePath: string): void {
  if (isAgentDeniedReadPath(relativePath)) {
    throw new Error(
      `access denied: '${relativePath}' holds credentials and is not readable by agent tools`,
    );
  }
}
