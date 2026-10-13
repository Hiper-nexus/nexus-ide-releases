/**
 * Canonical list of adapters whose auth is materialized as a file in a
 * managed home. Kept Node-free so renderer and main can share the exact guard.
 */
export const FILE_AUTH_ADAPTER_IDS = [
  'codex',
  'grok',
  'kimi',
  'opencode',
  'mimo-code',
  'agy',
  'openclaude',
  'minimax-code',
  'muse',
  // Devin grava TOML plano (sem seções) em
  // ~/.local/share/devin/credentials.toml. Os helpers de identidade/frescor de
  // managed-credentials são JSON-shaped e devolvem null para ele — por isso o
  // adapter tem ramo próprio lá. Mantenha os dois lados em sincronia.
  'devin',
] as const;

export type FileAuthAdapterId = (typeof FILE_AUTH_ADAPTER_IDS)[number];

export function isFileAuthAdapter(
  adapterId: string,
): adapterId is FileAuthAdapterId {
  return (FILE_AUTH_ADAPTER_IDS as readonly string[]).includes(adapterId);
}
