import fs from 'node:fs';
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
import { getWorkspaceMemoryStore } from '../memory/workspace-memory';
import {
  isInsidePath,
} from '../orch/workspace-path';
import { triageResearchHits } from '../orch/jev-research-triage';
import { tryResolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { scanSkillsDirectory } from '../skills/skills-catalog';
import { createRipgrepSearchProvider } from './ripgrep-fallback';
import { SearchMixer } from './search-mixer';

/**
 * Live SearchMixer instances, one per workspace root. searchNow() cancels the
 * previous in-flight query on its own mixer, so a process-global instance let
 * one window cancel another workspace's search. Fail-closed when disabled.
 */

const mixers = new Map<string, SearchMixer>();

/** Workspace-scoped only — never $HOME. */
function skillsDirs(root: string): string[] {
  return [
    tryResolveSubdirUnderRoot(root, path.join('.claude', 'skills')),
    tryResolveSubdirUnderRoot(root, path.join('.nexus', 'skills')),
  ].filter((d): d is string => d != null);
}

function createMissionsProvider(): SearchSourceProvider {
  return {
    // Memory notes tagged kind=mission (not live mission store).
    source: 'missions',
    async search(query, signal) {
      if (signal.aborted || !query.workspaceId) return [];
      const store = getWorkspaceMemoryStore({
        projectId: query.workspaceId,
      });
      await store.ensureProjections();
      const notes = listMemoryNotes(store.projectionRoot).filter(
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
            subtitle: 'memory:mission',
            score: 0.85,
            snippet: n.body.slice(0, 160),
            meta: { memoryId: n.id },
          }),
        );
    },
  };
}

function createSkillsProvider(): SearchSourceProvider {
  return {
    source: 'skills',
    async search(query, signal) {
      if (signal.aborted || !query.projectRoot) return [];
      const root = query.projectRoot;
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

/**
 * Filename walk as source `workspaces` — MUST NOT use `files`, which would
 * overwrite the ripgrep provider in SearchMixer's Map (one provider per source).
 */
function createShallowFilenameProvider(): SearchSourceProvider {
  return {
    source: 'workspaces',
    async search(query, signal) {
      if (signal.aborted || !query.projectRoot) return [];
      const hits: SearchHit[] = [];
      const q = query.text.toLowerCase();
      const root = path.resolve(query.projectRoot);
      const walk = (dir: string, depth: number) => {
        if (depth > 2 || hits.length >= query.limit) return;
        if (!isInsidePath(root, dir)) return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (
            !name ||
            name === '.' ||
            name === '..' ||
            name === 'node_modules' ||
            name === '.git' ||
            name.startsWith('.')
          ) {
            continue;
          }
          const full = path.join(dir, name);
          let st: fs.Stats;
          try {
            st = fs.lstatSync(full);
          } catch {
            continue;
          }
          // Never follow or surface symlinks (could escape workspace).
          if (st.isSymbolicLink()) continue;
          if (!isInsidePath(root, full)) continue;
          if (name.toLowerCase().includes(q)) {
            hits.push({
              id: `ws-name:${full}`,
              source: 'workspaces',
              title: name,
              score: 0.55,
              path: full,
            });
          }
          if (st.isDirectory()) walk(full, depth + 1);
          if (hits.length >= query.limit) return;
        }
      };
      walk(root, 0);
      return hits;
    },
  };
}

function createMixer(projectRoot: string): SearchMixer {
  const mixer = new SearchMixer({ debounceMs: 80, defaultLimit: 30 });
  // Order: ripgrep owns `files`; shallow walk is `workspaces` (never same key).
  // The mixer key IS the authority: both IPC callers bind it from
  // requireScopedRoot(sender), never from the renderer. The ripgrep fallback
  // denies without allowedRoots (464dbcf00), so the root-less warm-up mixer
  // stays fail-closed and each workspace mixer may search only its own root.
  mixer.register(
    createRipgrepSearchProvider(
      projectRoot ? { allowedRoots: [projectRoot] } : {},
    ),
  );
  mixer.register(createMissionsProvider());
  mixer.register(createSkillsProvider());
  mixer.register(createShallowFilenameProvider());
  return mixer;
}

/** Mixer scoped to a workspace root ('' = default/warm-up instance). */
export function getSearchMixer(projectRoot?: string): SearchMixer {
  const key = projectRoot ?? '';
  let mixer = mixers.get(key);
  if (!mixer) {
    mixer = createMixer(key);
    mixers.set(key, mixer);
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
  const result = await getSearchMixer(query.projectRoot).searchNow(query);
  // Triagem Jev (superfície researchTriage): melhor hit + a pergunta está
  // respondida? — para o agente saber se fecha a pesquisa ou busca outra fonte.
  // Fail-open: sem chave/toggle o rank lexical continua mandando.
  try {
    const triage = await triageResearchHits(
      query.text,
      (result.hits ?? []).map((hit) => ({
        id: hit.id,
        title: hit.title,
        snippet: hit.snippet,
      })),
      'search-mixer',
      undefined,
    );
    if (triage) {
      const promoted = triage.bestHitId
        ? promoteBestHit(result.hits ?? [], triage.bestHitId)
        : result.hits;
      return { ...result, hits: promoted, triage };
    }
  } catch {
    // Julgamento nunca quebra a busca.
  }
  return result;
}

/** Move o hit escolhido pelo Jev ao topo, preservando a ordem relativa dos demais. */
export function promoteBestHit(hits: readonly SearchHit[], bestHitId: string): SearchHit[] {
  const bestIndex = hits.findIndex((hit) => hit.id === bestHitId);
  if (bestIndex <= 0) return [...hits];
  const best = hits[bestIndex]!;
  return [best, ...hits.slice(0, bestIndex), ...hits.slice(bestIndex + 1)];
}

/** Test-only. */
export function resetSearchMixerForTests(): void {
  for (const mixer of mixers.values()) mixer.cancel();
  mixers.clear();
}
