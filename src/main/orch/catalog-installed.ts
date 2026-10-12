import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledItem } from './catalog-contract';
import { listInstalledAgentPluginSkills } from './agent-plugin-catalog';

function scanDir(
  dir: string,
  kind: string,
  opts: { dirs?: boolean; ext?: string; requireFile?: string } = {},
): InstalledItem[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false;
        if (opts.dirs) {
          if (!entry.isDirectory()) return false;
          // F-1305: pasta de skill só é instalada se o SKILL.md for legível.
          if (opts.requireFile) {
            try {
              return fs
                .statSync(path.join(dir, entry.name, opts.requireFile))
                .isFile();
            } catch {
              return false;
            }
          }
          return true;
        }
        if (opts.ext) return entry.isFile() && entry.name.endsWith(opts.ext);
        return entry.isFile();
      })
      .map((entry) => {
        const file = path.join(dir, entry.name);
        const stat = fs.statSync(file);
        return {
          kind,
          name: entry.isDirectory()
            ? entry.name
            : path.basename(entry.name, path.extname(entry.name)),
          file,
          size: entry.isDirectory() ? 0 : stat.size,
          modifiedAt: stat.mtimeMs,
        };
      });
  } catch {
    return [];
  }
}

function uniqueInstalledItems(items: InstalledItem[]): InstalledItem[] {
  const seen = new Map<string, InstalledItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.name}`;
    const winner = seen.get(key);
    if (!winner) {
      seen.set(key, { ...item });
      continue;
    }
    // F-1308: nome duplicado colapsa em silêncio (first-wins); a vencedora
    // expõe de onde saiu a cópia ofuscada.
    winner.shadowedFrom = [...(winner.shadowedFrom ?? []), item.file];
  }
  return [...seen.values()];
}

export function listInstalledCatalogItems(
  home: string = os.homedir(),
): InstalledItem[] {
  const legacyRoot = path.join(home, '.nexus', 'plugins', 'catalog');
  const legacy = (() => {
    try {
      return fs.readdirSync(legacyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => scanDir(path.join(legacyRoot, entry.name), entry.name));
    } catch {
      return [];
    }
  })();
  return uniqueInstalledItems([
    ...scanDir(path.join(home, '.claude', 'agents'), 'agent', { ext: '.md' }),
    ...scanDir(path.join(home, '.claude', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.agents', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.codex', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.gemini', 'config', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.gemini', 'antigravity', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.kimi-code', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...scanDir(path.join(home, '.grok', 'skills'), 'skill', { dirs: true, requireFile: 'SKILL.md' }),
    ...listInstalledAgentPluginSkills(home),
    ...legacy,
  ]);
}

export function listPluginFiles(): InstalledItem[] {
  const root = path.join(os.homedir(), '.nexus', 'plugins');
  return [
    ...scanDir(path.join(root, 'adapters'), 'adapter'),
    ...scanDir(path.join(root, 'voice'), 'voice'),
    ...scanDir(path.join(root, 'themes'), 'theme'),
    ...scanDir(path.join(root, 'keybindings'), 'keybinding'),
  ];
}

export function listHookHomes(): InstalledItem[] {
  return scanDir(path.join(os.homedir(), '.nexus', 'ephemeral'), 'hook-home', {
    dirs: true,
  });
}
