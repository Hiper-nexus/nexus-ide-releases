import type { ProjectExecutionScope } from '../../shared/types';
import { computeBlastRadius } from '../context/orientation/orientation-blast-radius';
import { tryGetProjectOrientationService } from '../context/orientation/orientation-service';
import { extractMemoryLinkTargets, fileLinkTarget, filePathsOfTargets } from './memory-links';

export const MEMORY_IMPACT_MAX_MAP_AGE_MS = 30 * 60_000;

/** FTS first; relations add impact only. No disk scan, cache rebuild or new engine. */
export function memoryImpactTargets(scope: ProjectExecutionScope, prompt: string): readonly string[] {
  const map = tryGetProjectOrientationService()?.peek(scope);
  if (!map || map.projectId !== scope.projectId || map.checkoutId !== scope.checkoutId ||
      (map.status !== 'ready' && map.status !== 'partial')) return [];
  const age = Date.now() - Date.parse(map.builtAt);
  if (!Number.isFinite(age) || age < 0 || age > MEMORY_IMPACT_MAX_MAP_AGE_MS) return [];
  const text = prompt.slice(0, 16_384);
  const seeds = filePathsOfTargets(extractMemoryLinkTargets(text)).slice(0, 16);
  // Avoid the blast-radius helper's unrelated top-hub fallback for empty goals.
  const matched = map.symbols.hubs.some((hub) => text.toLowerCase().includes(hub.name.toLowerCase()));
  if (!seeds.length && !matched) return [];
  const radius = computeBlastRadius(map, { goal: text, seedFiles: seeds, depth: 2, maxFiles: 24 });
  return radius.files.map(fileLinkTarget).filter((target): target is string => target !== null);
}
