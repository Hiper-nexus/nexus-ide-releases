import fs from 'node:fs';
import os from 'node:os';
import type {
  CatalogEntry,
  CatalogIndex,
  InstalledItem,
} from './catalog-contract';
import { scanInstalledPlugins } from './agent-plugin-scan';

export function listAgentPluginCatalogEntries(
  home: string = os.homedir(),
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const plugin of scanInstalledPlugins(home)) {
    for (const skill of plugin.skills) {
      if (seen.has(skill.catalogEntry.slug)) continue;
      seen.add(skill.catalogEntry.slug);
      entries.push({ ...skill.catalogEntry });
    }
  }
  return entries;
}

export function withAgentPluginCatalogEntries(
  index: CatalogIndex,
  home: string = os.homedir(),
): CatalogIndex {
  const local = listAgentPluginCatalogEntries(home);
  if (local.length === 0) return index;
  const slugs = new Set(index.skills.map((entry) => entry.slug));
  return {
    ...index,
    skills: [
      ...local.filter((entry) => !slugs.has(entry.slug)),
      ...index.skills,
    ],
  };
}

export function listInstalledAgentPluginSkills(
  home: string = os.homedir(),
): InstalledItem[] {
  const items: InstalledItem[] = [];
  for (const plugin of scanInstalledPlugins(home)) {
    for (const skill of plugin.skills) {
      try {
        const stat = fs.statSync(skill.skillFile);
        items.push({
          kind: 'skill',
          name: skill.qualifiedName,
          file: skill.directory,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Concurrent component removal degrades only that component.
      }
    }
  }
  return items;
}
