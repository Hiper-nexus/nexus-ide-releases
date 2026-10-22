import type { UiKitInstallView } from '../../shared/ui-kit-contract';
import type { UiKitRunResult } from './ui-kit-service';

/**
 * A finished install, as the panel reads it.
 *
 * This is a module of its own because the IPC that used to hold it cannot be
 * loaded under test (`handleTrusted` pulls in electron), and the one thing it
 * does wrong is invisible from the outside: the DIRECT install path forwarded
 * `ok`, `installed` and `missingRegistryKeys` and dropped the licence verdict,
 * so installing a Pro item by name showed the operator a bare "A instalação
 * falhou." with nothing about the licence that would have fixed it.
 *
 * Pure on purpose: no cwd, no vault, no spawn.
 */

/** What a recipe resolved to, as far as the view is concerned. */
export interface RecipeOutcomeForView {
  readonly install: readonly string[];
  readonly unresolved: readonly string[];
  /** Role keys whose only match was a Pro item. */
  readonly licensedRoles: readonly string[];
}

const OUTPUT_LIMIT = 8_000;

function runOutput(run: UiKitRunResult): string {
  return `${run.stdout}\n${run.stderr}`.trim().slice(0, OUTPUT_LIMIT);
}

/**
 * Names that need the licence: the recipe's Pro-only roles first, then items
 * the run itself refused once the vendor's live tiers were known. One is a
 * role key and the other a slug, which is why the panel's wording names
 * neither — both answer "what you cannot have without the key".
 */
function licenceNames(
  run: UiKitRunResult,
  recipe: RecipeOutcomeForView | null,
): readonly string[] {
  const roles = recipe?.licensedRoles ?? [];
  const refused = (run.needsLicense ?? []).filter((item) => !roles.includes(item));
  return [...roles, ...refused];
}

/**
 * The view for a dry run over NAMED items.
 *
 * Deliberately not `installViewFromPlan`: a blocked Pro item is not an
 * unresolved role. Saying "no catalogue item for X" about something that
 * exists and needs a key would send the operator looking for the wrong thing.
 */
export function installViewFromItemPlan(plan: {
  readonly install: readonly string[];
  readonly needsLicense: readonly string[];
  readonly licenseState?: UiKitInstallView['licenseState'];
}): UiKitInstallView {
  return {
    // Not ok: the caller named items that this project cannot install.
    ok: plan.needsLicense.length === 0,
    installed: [...plan.install],
    ...(plan.needsLicense.length > 0 ? { needsLicense: [...plan.needsLicense] } : {}),
    ...(plan.licenseState ? { licenseState: plan.licenseState } : {}),
  };
}

/** The view for an install that ran. */
export function installViewFromRun(
  run: UiKitRunResult,
  options: {
    /** What was asked for: the recipe's picks, or the named items. */
    readonly requested: readonly string[];
    readonly recipe?: RecipeOutcomeForView | null;
  },
): UiKitInstallView {
  const recipe = options.recipe ?? null;
  const needsLicense = licenceNames(run, recipe);
  return {
    ok: run.ok,
    installed: run.ok ? [...options.requested] : [],
    ...(recipe ? { unresolved: [...recipe.unresolved] } : {}),
    ...(needsLicense.length > 0 ? { needsLicense } : {}),
    ...(run.licenseState ? { licenseState: run.licenseState } : {}),
    missingRegistryKeys: run.missingRegistryKeys,
    output: runOutput(run),
  };
}

/**
 * The view for a recipe that resolved to nothing to install, or a dry run.
 *
 * Nothing ran, so there is no licence verdict from the vendor — only the
 * recipe's own finding that a role had no free match.
 */
export function installViewFromPlan(recipe: RecipeOutcomeForView): UiKitInstallView {
  return {
    ok: recipe.unresolved.length === 0,
    installed: [...recipe.install],
    unresolved: [...recipe.unresolved],
    ...(recipe.licensedRoles.length > 0
      ? { needsLicense: [...recipe.licensedRoles] }
      : {}),
  };
}

/**
 * The receipt an AGENT gets from `nexus_ui_kit_add`.
 *
 * Separate from the panel's view because an agent reads different things (the
 * exit code, the raw output) — but the licence verdict has to survive both
 * ways out. This path used to drop `needsLicense` and `licenseState` and leave
 * the refusal in free-form `output`, so a model could neither name the blocked
 * items nor tell "no key stored" from "vendor unreachable".
 */
export function agentInstallReceipt(
  run: UiKitRunResult,
  asked: { readonly kit: string; readonly items: readonly string[] },
): Record<string, unknown> {
  const needsLicense = run.needsLicense ?? [];
  return {
    ok: run.ok,
    kit: asked.kit,
    installed: run.ok ? [...asked.items] : [],
    exitCode: run.code,
    output: `${run.stdout}\n${run.stderr}`.trim().slice(0, 20_000),
    ...(needsLicense.length > 0
      ? {
          needsLicense,
          licenceHint:
            'Those items are BoardUI Pro. The operator stores the licence in ' +
            'Settings → UI kits; the free items need no key.',
        }
      : {}),
    ...(run.licenseState ? { licenseState: run.licenseState } : {}),
    ...(run.missingRegistryKeys.length > 0
      ? {
          missingRegistryKeys: run.missingRegistryKeys,
          hint:
            'Those registries have no token stored. Settings → UI kits → ' +
            'registries, or install from a keyless registry.',
        }
      : {}),
  };
}
