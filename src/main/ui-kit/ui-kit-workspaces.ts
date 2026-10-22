import fs from 'node:fs';
import path from 'node:path';
import { assertPathStaysInProject } from './ui-kit-cli';

/**
 * The packages of a monorepo, as the PROJECT declares them.
 *
 * The kit always ran at the execution root, so in a monorepo the component
 * landed in the root — not in `apps/web`, where the UI lives (review 22/10).
 * A free path argument is the class this surface refuses (see tools-ui-kit),
 * so the agent picks from THIS list instead: Main reads `workspaces` from the
 * root package.json and `packages:` from pnpm-workspace.yaml, expands the
 * simple globs they use (`apps/*`), and only directories that exist, hold a
 * package.json and stay inside the project (links walked) are offered.
 */
export const UI_KIT_MAX_WORKSPACES = 64;

function declaredPatterns(root: string): readonly string[] {
  const patterns: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    const raw = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces && typeof pkg.workspaces === 'object'
        ? (pkg.workspaces as { packages?: unknown }).packages
        : undefined;
    if (Array.isArray(raw)) {
      for (const entry of raw) if (typeof entry === 'string') patterns.push(entry);
    }
  } catch {
    // No root package.json, or not JSON: no npm/yarn workspaces.
  }
  try {
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    let inPackages = false;
    for (const line of yaml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) break;
      const item = inPackages ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line) : null;
      if (item?.[1]) patterns.push(item[1].trim());
    }
  } catch {
    // No pnpm workspace file.
  }
  return patterns;
}

function hasPackageJson(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}

/** `apps/*` and `packages/**` expand one level; `!x` excludes; exact dirs pass. */
export function listUiKitWorkspaces(root: string): readonly string[] {
  const found = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of declaredPatterns(root)) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) continue;
    const targets: string[] = [];
    const glob = /^(.*?)\/\*\*?$/.exec(pattern);
    if (glob) {
      const base = glob[1] ?? '';
      if (base.includes('*')) continue;
      try {
        for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            targets.push(base ? `${base}/${entry.name}` : entry.name);
          }
        }
      } catch {
        continue;
      }
    } else if (!pattern.includes('*')) {
      targets.push(pattern);
    }
    for (const rel of targets) (negated ? excluded : found).add(rel);
  }
  return [...found]
    .filter((rel) => !excluded.has(rel))
    .filter((rel) => hasPackageJson(path.join(root, rel)))
    .filter((rel) => {
      try {
        assertPathStaysInProject(root, rel);
        return true;
      } catch {
        return false;
      }
    })
    .sort()
    .slice(0, UI_KIT_MAX_WORKSPACES);
}

/**
 * The directory to run in for a `workspace` the agent named, or the root.
 * Anything not on the enumerated list is refused by name — never resolved.
 */
export function resolveUiKitWorkspace(root: string, workspace: string | undefined): string {
  if (workspace === undefined || workspace.trim() === '' || workspace.trim() === '.') return root;
  const wanted = workspace.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const known = listUiKitWorkspaces(root);
  if (!known.includes(wanted)) {
    throw new Error(
      `unknown workspace: ${wanted.slice(0, 64)} — this project declares ` +
        (known.length > 0 ? known.join(', ') : 'no workspaces'),
    );
  }
  return path.join(root, wanted);
}
