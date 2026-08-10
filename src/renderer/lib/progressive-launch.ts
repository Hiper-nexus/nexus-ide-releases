/**
 * Persist progressive onboarding launch plan across workspace open → layout hydrate.
 */
import {
  progressiveLaunchSchema,
  type ProgressiveLaunch,
} from '../../shared/progressive-onboarding';
import { listPanes } from './split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

const STORAGE_KEY = 'nexus.progressiveLaunch.v1';

export function stashProgressiveLaunch(plan: ProgressiveLaunch): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  } catch {
    /* private mode / quota */
  }
}

export function clearProgressiveLaunch(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function takeProgressiveLaunch(): ProgressiveLaunch | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return progressiveLaunchSchema.parse(JSON.parse(raw));
  } catch {
    clearProgressiveLaunch();
    return null;
  }
}

/**
 * Apply a progressive launch plan after the workspace layout has hydrated.
 * Safe to call once; no-op if nothing was stashed.
 */
export function applyProgressiveLaunchIfPending(): boolean {
  const plan = takeProgressiveLaunch();
  if (!plan) return false;

  // Expand to requested shell panes (capped by soft limit inside store).
  const target = Math.min(plan.paneCount, 12);
  while (listPanes(useLayoutStore.getState().root).length < target) {
    const before = listPanes(useLayoutStore.getState().root).length;
    useLayoutStore.getState().addShellPane();
    const after = listPanes(useLayoutStore.getState().root).length;
    if (after <= before) break; // store refused (cap / no-op)
  }

  const navigation = useProductNavigationStore.getState();
  switch (plan.mode) {
    case 'missions':
    case 'swarm':
      navigation.openMissionSetup();
      break;
    case 'board':
      navigation.openTaskBoard();
      break;
    case 'memory':
      navigation.openMemory();
      break;
    case 'skills':
      navigation.openSettings('skills');
      break;
    case 'terminal-only':
      navigation.openTerminal();
      break;
  }

  return true;
}
