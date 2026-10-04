import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { getActiveCliMcpArtifact, MAX_CLI_TOML_CONFIG_BYTES, MAX_CLI_TOML_CONFIG_DEPTH } from './cli-mcp-session-artifacts';
import { writeFileAtomicAsync } from '../util/atomic-write';

const CHANNEL_KEYS = ['NEXUS_HEAVY_CHANNEL_DIR', 'NEXUS_HEAVY_CHANNEL_KEY', 'NEXUS_HEAVY_CHANNEL_EPOCH', 'NEXUS_HEAVY_CHANNEL_PUBLIC_KEY'];
const CORE_KEYS = ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER'];
type Table = Record<string, unknown>;
const table = (value: unknown): Table => value && typeof value === 'object' && !Array.isArray(value) ? value as Table : {};
const policyTable = (value: unknown): Table => {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('codex_heavy_environment_policy_invalid');
  return table(value);
};
const patterns = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || item.length > 256)) throw new Error('codex_heavy_environment_policy_invalid');
  return value;
};
/** Codex 0.160 uses WildMatch patterns with only '*' and '?', ignoring case. */
function matches(name: string, pattern: string): boolean {
  name = name.toUpperCase(); pattern = pattern.toUpperCase();
  let n = 0, p = 0, star = -1, retry = 0;
  while (n < name.length) {
    if (pattern[p] === '?' || pattern[p] === name[n]) { n++; p++; }
    else if (pattern[p] === '*') { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function inheritedNames(policy: Table, names: readonly string[]): string[] {
  if (names.length > 512 || names.some(name => name.length > 256)) throw new Error('codex_heavy_environment_policy_invalid');
  let exclude = patterns(policy.exclude), include = patterns(policy.include_only);
  if (policy.ignore_default_excludes !== undefined && typeof policy.ignore_default_excludes !== 'boolean') throw new Error('codex_heavy_environment_policy_invalid');
  if (policy.filters !== undefined) {
    if (policy.exclude !== undefined || policy.include_only !== undefined) throw new Error('codex_heavy_environment_policy_invalid');
    const filters = Object.entries(policyTable(policy.filters));
    patterns(filters.map(([pattern]) => pattern));
    if (filters.some(([, action]) => action !== 'include' && action !== 'exclude')) throw new Error('codex_heavy_environment_policy_invalid');
    if (new Set(filters.map(([pattern]) => pattern.toLowerCase())).size !== filters.length) throw new Error('codex_heavy_environment_policy_invalid');
    exclude = filters.filter(([, action]) => action === 'exclude').map(([pattern]) => pattern);
    include = filters.filter(([, action]) => action === 'include').map(([pattern]) => pattern);
  }
  const inherit = policy.inherit ?? 'all';
  if (!['all', 'core', 'none'].includes(String(inherit))) throw new Error('codex_heavy_environment_policy_invalid');
  const selected = names.filter(name => inherit === 'all' || inherit === 'core' && CORE_KEYS.includes(name.toUpperCase()))
    .filter(name => policy.ignore_default_excludes !== false || !['*KEY*', '*SECRET*', '*TOKEN*'].some(pattern => matches(name, pattern)))
    .filter(name => !exclude.some(pattern => matches(name, pattern)));
  return [...new Set([...selected, ...Object.keys(table(policy.set))])]
    .filter(name => !include.length || include.some(pattern => matches(name, pattern)));
}
export interface CodexHeavyChannelPolicy extends Table {
  shell_environment_policy: Table & { include_only: string[]; set: Table };
}
/** Seal inherited names for the file channel without changing network or filesystem policy. */
export function codexNativeHeavyChannelPolicy(input: Table, environmentNames: readonly string[]): CodexHeavyChannelPolicy {
  const config = structuredClone(input), shell = policyTable(config.shell_environment_policy);
  const settings = policyTable(shell.set);
  if (Object.values(settings).some(value => typeof value !== 'string')) throw new Error('codex_heavy_environment_policy_invalid');
  const names = inheritedNames(shell, environmentNames), overrides = { ...settings };
  for (const key of CHANNEL_KEYS) delete overrides[key];
  delete shell.filters;
  config.shell_environment_policy = { ...shell, inherit: 'all', ignore_default_excludes: true,
    exclude: [], include_only: [...new Set([...names, ...CHANNEL_KEYS])], set: overrides };
  return config as CodexHeavyChannelPolicy;
}
/** Used only for non-governed Codex after the Main-owned session reservation. */
export async function configureCodexNativeHeavyChannel(token: string, env: Readonly<Record<string, string>>, environmentNames: readonly string[], assertCurrent: () => void): Promise<void> {
  const artifact = getActiveCliMcpArtifact(token);
  const current = () => { assertCurrent(); if (!artifact || getActiveCliMcpArtifact(token) !== artifact) throw new Error('codex_heavy_artifact_changed'); };
  current();
  if (!artifact?.providerHome || path.basename(path.dirname(artifact.artifactDir)) !== 'codex' ||
      Object.keys(env).some(key => !CHANNEL_KEYS.includes(key)) || CHANNEL_KEYS.some(key => typeof env[key] !== 'string' || !env[key])) throw new Error('codex_heavy_channel_context_invalid');
  const directory = artifact.artifactDir, file = path.join(directory, 'config.toml');
  if (await fs.promises.realpath(directory) !== directory) throw new Error('codex_heavy_artifact_changed'); current();
  const parent = await fs.promises.lstat(directory); current();
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('codex_heavy_artifact_changed');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let original: fs.Stats, raw: string;
  try {
    current();
    original = await handle.stat(); current();
    if (!original.isFile() || original.size > MAX_CLI_TOML_CONFIG_BYTES) throw new Error('codex_heavy_config_invalid');
    const bytes = Buffer.alloc(original.size + 1); let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total); current();
      if (!read.bytesRead) break; total += read.bytesRead;
    }
    if (total !== original.size) throw new Error('codex_heavy_config_invalid'); raw = bytes.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
  current();
  const policy = codexNativeHeavyChannelPolicy(parse(raw, { maxDepth: MAX_CLI_TOML_CONFIG_DEPTH }) as Table, environmentNames);
  const sealed = `${stringify(policy).trimEnd()}\n`;
  if (Buffer.byteLength(sealed) > MAX_CLI_TOML_CONFIG_BYTES) throw new Error('codex_heavy_config_invalid');
  await writeFileAtomicAsync(file, sealed, 0o600, { createDirectory: false, beforeCommit: () => {
    current();
    const nowParent = fs.lstatSync(directory), nowFile = fs.lstatSync(file);
    if (fs.realpathSync(directory) !== directory || nowParent.dev !== parent.dev || nowParent.ino !== parent.ino ||
        nowFile.isSymbolicLink() || nowFile.dev !== original.dev || nowFile.ino !== original.ino || nowFile.size !== original.size || nowFile.mtimeMs !== original.mtimeMs) throw new Error('codex_heavy_artifact_changed');
  } });
  current();
}
