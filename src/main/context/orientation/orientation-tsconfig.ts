import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';

export interface TsconfigAliasMap {
  /** Repo-relative posix directory that path targets are joined against. */
  readonly baseUrl: string;
  /** Alias prefix (e.g. "@/*") -> target patterns (e.g. ["./src/*"]). */
  readonly paths: ReadonlyMap<string, readonly string[]>;
}

/** Strip `//` and `/* *‍/` comments from JSONC while leaving string contents intact. */
function stripJsonComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === '\\' && i < n) {
          out += source[i];
          i += 1;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseJsonc(source: string): unknown {
  const withoutComments = stripJsonComments(source);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

/** Alias settings accumulated along an `extends` chain, as repo-relative dirs. */
interface ResolvedTsconfig {
  /** baseUrl, already joined with the dir of the config that declared it. */
  readonly baseUrl?: string;
  readonly paths?: Readonly<Record<string, unknown>>;
  /** Dir of the config that declared `paths` (their base when no baseUrl). */
  readonly pathsDir?: string;
}

const MAX_EXTENDS_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve one config and its relative `extends` (a string or, since TS 5.0,
 * an array applied in order). Like tsc, `baseUrl` is relative to the file
 * that declares it, and `paths` without a baseUrl are relative to the file
 * that declares them. Package `extends` (no leading dot) are skipped.
 */
function readTsconfigChain(
  scope: ProjectExecutionScope,
  relativePath: string,
  depth: number,
): ResolvedTsconfig | null {
  if (depth > MAX_EXTENDS_DEPTH) return null;
  let raw: unknown;
  try {
    raw = parseJsonc(readWorkspaceTextFile(scope, relativePath).content);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const configDir = path.posix.dirname(relativePath);
  let resolved: ResolvedTsconfig = {};
  const parents = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  for (const parent of parents) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    let parentRelative = path.posix.normalize(path.posix.join(configDir, parent));
    if (!parentRelative.endsWith('.json')) parentRelative = `${parentRelative}.json`;
    const inherited = readTsconfigChain(scope, parentRelative, depth + 1);
    if (inherited) resolved = { ...resolved, ...definedOnly(inherited) };
  }
  const options = isRecord(raw.compilerOptions) ? raw.compilerOptions : {};
  if (typeof options.baseUrl === 'string') {
    resolved = {
      ...resolved,
      baseUrl: path.posix.normalize(path.posix.join(configDir, options.baseUrl)),
    };
  }
  if (isRecord(options.paths)) {
    resolved = { ...resolved, paths: options.paths, pathsDir: configDir };
  }
  return resolved;
}

function definedOnly(config: ResolvedTsconfig): ResolvedTsconfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as ResolvedTsconfig;
}

/**
 * Load `compilerOptions.paths`/`baseUrl` from the scanned project's own
 * tsconfig.json (following relative `extends`, string or array), so
 * `@/...`-style aliases resolve to real files during import-graph
 * construction. Returns null when there is no usable tsconfig or no `paths`;
 * never throws — a malformed config only costs the aliases, not the map.
 */
export function loadTsconfigAliases(
  scope: ProjectExecutionScope,
  tsconfigRelativePath = 'tsconfig.json',
): TsconfigAliasMap | null {
  try {
    const resolved = readTsconfigChain(scope, tsconfigRelativePath, 0);
    if (!resolved?.paths) return null;
    const baseUrl = resolved.baseUrl ?? resolved.pathsDir ?? '.';
    const map = new Map<string, readonly string[]>();
    for (const [prefix, targets] of Object.entries(resolved.paths)) {
      if (!Array.isArray(targets)) continue;
      const strings = targets.filter((target): target is string => typeof target === 'string');
      if (strings.length > 0) map.set(prefix, Object.freeze(strings));
    }
    if (map.size === 0) return null;
    return Object.freeze({ baseUrl, paths: map });
  } catch {
    return null;
  }
}

function matchAliasPrefix(spec: string, prefix: string): string | null {
  const starIndex = prefix.indexOf('*');
  if (starIndex < 0) return spec === prefix ? '' : null;
  const head = prefix.slice(0, starIndex);
  const tail = prefix.slice(starIndex + 1);
  if (!spec.startsWith(head) || !spec.endsWith(tail)) return null;
  if (spec.length < head.length + tail.length) return null;
  return spec.slice(head.length, spec.length - tail.length);
}

/** Candidate repo-relative bases (without extension) for an aliased specifier. */
export function resolveAliasCandidateBases(
  spec: string,
  aliases: TsconfigAliasMap,
): readonly string[] {
  const bases: string[] = [];
  for (const [prefix, targets] of aliases.paths) {
    const wildcard = matchAliasPrefix(spec, prefix);
    if (wildcard === null) continue;
    for (const target of targets) {
      const substituted = target.includes('*') ? target.replace('*', wildcard) : target;
      bases.push(path.posix.normalize(path.posix.join(aliases.baseUrl, substituted)));
    }
  }
  return Object.freeze(bases);
}
