import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type {
  SearchHit,
  SearchPartialResult,
  SearchQuery,
  SearchSourceProvider,
} from '../../shared/search-mixer-types';
import { searchQuerySchema } from '../../shared/search-mixer-types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { listMemoryNotes } from '../memory/nexus-memory';
import { scanSkillsDirectory } from '../skills/skills-catalog';
import { createRipgrepSearchProvider } from './ripgrep-fallback';
import { SearchMixer } from './search-mixer';

/**
 * Live SearchMixer singleton. Registers ripgrep + skills + missions/memory
 * providers when the feature flag is on. Fail-closed when disabled.
 */

let mixer: SearchMixer | null = null;

function skillsDirs(root: string): string[] {
  return [
    path.join(root, '.claude', 'skills'),
    path.join(root, '.nexus', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ];
}

function createMissionsProvider(): SearchSourceProvider {
  return {
    source: 'missions',
    async search(query, signal) {
      if (signal.aborted || !query.projectRoot) return [];
      const notes = listMemoryNotes(query.projectRoot).filter(
        (n) => n.kind === 'mission',
      );
      const q = query.text.toLowerCase();
      return notes
        .filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.body.toLowerCase().includes(q),
        )
        .slice(0, query.limit)
        .map(
          (n): SearchHit => ({
            id: `mission-note:${n.id}`,
            source: 'missions',
            title: n.title,
            subtitle: n.kind,
            score: 0.85,
            snippet: n.body.slice(0, 160),
            path: n.path,
          }),
        );
    },
  };
}

function createSkillsProvider(): SearchSourceProvider {
  return {
    source: 'skills',
    async search(query, signal) {
      if (signal.aborted) return [];
      const root = query.projectRoot ?? process.cwd();
      const q = query.text.toLowerCase();
      const skills = skillsDirs(root).flatMap((d) => {
        try {
          return scanSkillsDirectory(d);
        } catch {
          return [];
        }
      });
      return skills
        .filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
        .slice(0, query.limit)
        .map(
          (s): SearchHit => ({
            id: `skill:${s.id}`,
            source: 'skills',
            title: s.name,
            subtitle: s.category,
            score: 0.8,
            snippet: s.description.slice(0, 160),
            path: s.path,
          }),
        );
    },
  };
}

function createShallowFilesProvider(): SearchSourceProvider {
  return {
    source: 'workspaces',
    async search(query, signal) {
      if (signal.aborted || !query.projectRoot) return [];
      const hits: SearchHit[] = [];
      const q = query.text.toLowerCase();
      const root = query.projectRoot;
      const walk = (dir: string, depth: number) => {
        if (depth > 2 || hits.length >= query.limit) return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (name === 'node_modules' || name === '.git' || name.startsWith('.'))
            continue;
          const full = path.join(dir, name);
          if (name.toLowerCase().includes(q)) {
            hits.push({
              id: `ws-file:${full}`,
              source: 'workspaces',
              title: name,
              score: 0.55,
              path: full,
            });
          }
          try {
            if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
          } catch {
            /* skip */
          }
          if (hits.length >= query.limit) return;
        }
      };
      walk(root, 0);
      return hits;
    },
  };
}

export function getSearchMixer(): SearchMixer {
  if (!mixer) {
    mixer = new SearchMixer({ debounceMs: 80, defaultLimit: 30 });
    mixer.register(createRipgrepSearchProvider());
    mixer.register(createMissionsProvider());
    mixer.register(createSkillsProvider());
    mixer.register(createShallowFilesProvider());
  }
  return mixer;
}

export function isSearchMixerEnabled(): boolean {
  return getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.searchMixer);
}

/** Immediate search for IPC; empty when flag off. */
export async function runSearchMixerQuery(
  raw: unknown,
): Promise<SearchPartialResult> {
  if (!isSearchMixerEnabled()) {
    return {
      generation: 0,
      query: '',
      hits: [],
      partial: false,
      completedSources: [],
      cancelled: false,
      elapsedMs: 0,
    };
  }
  const query = searchQuerySchema.parse(raw) as SearchQuery;
  return getSearchMixer().searchNow(query);
}

/** Test-only. */
export function resetSearchMixerForTests(): void {
  mixer?.cancel();
  mixer = null;
}
