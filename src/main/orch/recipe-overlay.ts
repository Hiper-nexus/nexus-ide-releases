import type { RecipeOverlayResult } from '../../shared/types';
import { countAgentCategories, lintSquadRecipes } from '../../shared/recipe-lint';
import { listSquads } from './squad-store';
import { listInstalledCatalogItems } from './catalog';
import { getToolCatalog } from './mcp-server';
import {
  effectiveStacks,
  getCatalogOverlay,
  proposeRecipes,
} from './catalog-overlay';

export function buildRecipeOverlay(workspacePath?: string): RecipeOverlayResult {
  const squads = listSquads();
  const tools = getToolCatalog();
  const installed = listInstalledCatalogItems();
  const issues = lintSquadRecipes({
    squads,
    catalog: {
      toolNames: tools.map((tool) => tool.name),
      skillNames: installed
        .filter((item) => item.kind === 'skill')
        .map((item) => item.name),
    },
  });
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    checkedAt: Date.now(),
    stacks: effectiveStacks(workspacePath),
    overlay: getCatalogOverlay(workspacePath),
    suggestions: proposeRecipes(workspacePath),
    categories: countAgentCategories(squads),
    issues,
  };
}
