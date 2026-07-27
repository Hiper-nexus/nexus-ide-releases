/**
 * Canonical list of adapters whose auth is materialized as a file in a
 * managed home. Kept Node-free so renderer and main can share the exact guard.
 */
export const FILE_AUTH_ADAPTER_IDS = [
  'codex',
  'grok',
  'kimi',
  'opencode',
  'agy',
] as const;

export type FileAuthAdapterId = (typeof FILE_AUTH_ADAPTER_IDS)[number];

export function isFileAuthAdapter(
  adapterId: string,
): adapterId is FileAuthAdapterId {
  return (FILE_AUTH_ADAPTER_IDS as readonly string[]).includes(adapterId);
}
