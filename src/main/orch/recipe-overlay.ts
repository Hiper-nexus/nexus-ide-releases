import type { RecipeOverlayResult } from '../../shared/types';
import { countAgentCategories, lintSquadRecipes } from '../../shared/recipe-lint';
import { listSquads } from './squad-store';
import { listInstalledCatalogItems } from './catalog';
import { BUNDLED_GUIDED_SKILLS } from './guided-squad-skills';
import { getToolCatalog } from './mcp-server';
import {
  effectiveStacks,
  getCatalogOverlay,
  proposeRecipes,
} from './catalog-overlay';

export async function buildRecipeOverlay(workspacePath?: string): Promise<RecipeOverlayResult> {
  const squads = listSquads();
  const tools = await getToolCatalog();
  const installed = listInstalledCatalogItems();
  const issues = lintSquadRecipes({
    squads,
    catalog: {
      toolNames: tools.map((tool) => tool.name),
      skillNames: [
        // Skills que o próprio Nexus empacota existem por construção: o
        // skill-mirror as materializa a partir do bundle. Sem isso o lint
        // acusaria o vocabulário do app como "ausente do catálogo local"
        // enquanto nenhum pane ainda tiver espelhado para a home do provider.
        ...BUNDLED_GUIDED_SKILLS,
        ...installed
          .filter((item) => item.kind === 'skill')
          .map((item) => item.name),
      ],
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
