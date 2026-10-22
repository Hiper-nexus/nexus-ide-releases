import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether the project can take what the kits write.
 *
 * Both kits write React components for the web. Installing them into a Vue,
 * Svelte, Angular or Expo project "succeeded" and left files that cannot run;
 * the refusal names the framework and the way forward instead.
 *
 * Tailwind v3 is a WARNING, and only for BoardUI: the shadcn CLI detects the
 * Tailwind version and writes v3 or v4 accordingly (read in its dist,
 * 22/10/2026), while BoardUI's styles are written for v4 and nothing in its
 * package says it adapts. Not proven enough to refuse.
 *
 * Read from package.json only, and only to refuse what is KNOWN not to fit:
 * a monorepo root, an empty project or a version spec that is not a number
 * (`catalog:`, `workspace:*`) is not evidence against the kit.
 */
export type UiKitProjectFit =
  | { readonly ok: true; readonly warning?: string }
  | {
      readonly ok: false;
      readonly reason: 'framework_unsupported';
      readonly detail: string;
    };

const NON_REACT_FRAMEWORKS: readonly (readonly [string, string])[] = [
  ['nuxt', 'Nuxt'],
  ['vue', 'Vue'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact'],
];

const NATIVE_FRAMEWORKS: readonly (readonly [string, string])[] = [
  ['expo', 'Expo'],
  ['react-native', 'React Native'],
];

function readDependencies(cwd: string): Record<string, string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: Record<string, string> = {};
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[field];
      if (!block || typeof block !== 'object') continue;
      for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
        if (typeof spec === 'string') merged[name] = spec;
      }
    }
    return merged;
  } catch {
    return null;
  }
}

/** `^3.4.17` → 3; `catalog:`, `workspace:*`, `latest` → null. */
function majorOf(spec: string): number | null {
  const match = /^[\s^~>=v]*(\d+)/.exec(spec);
  return match ? Number(match[1]) : null;
}

export function uiKitProjectFit(cwd: string, kit: 'shadcn' | 'boardui' = 'shadcn'): UiKitProjectFit {
  const deps = readDependencies(cwd);
  if (!deps) return { ok: true };

  const native = NATIVE_FRAMEWORKS.find(([name]) => name in deps);
  if (native) {
    return {
      ok: false,
      reason: 'framework_unsupported',
      detail:
        `This is a ${native[1]} project; shadcn/ui and BoardUI write web (DOM) React ` +
        'components that do not run there. Use a React Native kit, or write the screen ' +
        'with the project design contract.',
    };
  }
  if (!('react' in deps)) {
    const other = NON_REACT_FRAMEWORKS.find(([name]) => name in deps);
    if (other) {
      return {
        ok: false,
        reason: 'framework_unsupported',
        detail:
          `This is a ${other[1]} project; shadcn/ui and BoardUI install React components. ` +
          'Use the framework\'s own port (shadcn-vue, shadcn-svelte, spartan for Angular) ' +
          'or write it with the project design contract.',
      };
    }
  }
  const tailwind = deps.tailwindcss ? majorOf(deps.tailwindcss) : null;
  if (kit === 'boardui' && tailwind !== null && tailwind < 4) {
    return {
      ok: true,
      warning:
        `This project is on Tailwind v${tailwind}; BoardUI's styles are written for ` +
        'Tailwind v4. If the build breaks, upgrade with `npx @tailwindcss/upgrade`.',
    };
  }
  return { ok: true };
}
