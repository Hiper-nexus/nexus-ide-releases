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

interface RawTsconfig {
  readonly extends?: string;
  readonly compilerOptions?: {
    readonly baseUrl?: string;
    readonly paths?: Record<string, readonly string[]>;
  };
}

const MAX_EXTENDS_DEPTH = 5;

function readTsconfigChain(
  scope: ProjectExecutionScope,
  relativePath: string,
  depth: number,
): RawTsconfig | null {
  if (depth > MAX_EXTENDS_DEPTH) return null;
  let raw: RawTsconfig;
  try {
    const read = readWorkspaceTextFile(scope, relativePath);
    raw = parseJsonc(read.content) as RawTsconfig;
  } catch {
    return null;
  }
  if (!raw.extends || !raw.extends.startsWith('.')) return raw;

  const parentDir = path.posix.dirname(relativePath);
  let parentRelative = path.posix.normalize(path.posix.join(parentDir, raw.extends));
  if (!parentRelative.endsWith('.json')) parentRelative = `${parentRelative}.json`;
  const parent = readTsconfigChain(scope, parentRelative, depth + 1);
  if (!parent) return raw;
  return {
    extends: raw.extends,
    compilerOptions: {
      baseUrl: raw.compilerOptions?.baseUrl ?? parent.compilerOptions?.baseUrl,
      paths: raw.compilerOptions?.paths ?? parent.compilerOptions?.paths,
    },
  };
}

/**
 * Load `compilerOptions.paths`/`baseUrl` from the scanned project's own
 * tsconfig.json (following one level of `extends` chains), so `@/...`-style
 * aliases resolve to real files during import-graph construction. Returns
 * null when there is no tsconfig.json or no `paths` configured.
 */
export function loadTsconfigAliases(
  scope: ProjectExecutionScope,
  tsconfigRelativePath = 'tsconfig.json',
): TsconfigAliasMap | null {
  const resolved = readTsconfigChain(scope, tsconfigRelativePath, 0);
  const paths = resolved?.compilerOptions?.paths;
  if (!paths || Object.keys(paths).length === 0) return null;
  const baseUrl = path.posix.normalize(
    path.posix.join(path.posix.dirname(tsconfigRelativePath), resolved?.compilerOptions?.baseUrl ?? '.'),
  );
  const map = new Map<string, readonly string[]>();
  for (const [prefix, targets] of Object.entries(paths)) {
    if (Array.isArray(targets) && targets.length > 0) map.set(prefix, Object.freeze([...targets]));
  }
  if (map.size === 0) return null;
  return Object.freeze({ baseUrl, paths: map });
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
