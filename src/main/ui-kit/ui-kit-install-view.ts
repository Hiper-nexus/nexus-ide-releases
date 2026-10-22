import {
  UI_KIT_SETTINGS_PATH,
  type UiKitInstallFilesView,
  type UiKitInstallView,
} from '../../shared/ui-kit-contract';
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

export interface InstallFiles extends UiKitInstallFilesView {
  /** False when the output carried none of the markers read below. */
  readonly recognized: boolean;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SHADCN_SECTION = /^\S*\s*(Created|Updated|Skipped)\s+\d+\s+files?:/i;
const LIST_ENTRY = /^\s+-\s+(\S.*)$/;
const BOARDUI_WRITTEN = /Done\.\s+(\d+)\s+files?\s+written/i;
const BOARDUI_SKIPPED = /skipped\s+(\d+)\s+existing\s+files?/i;

/**
 * What an install actually wrote, read from the vendor's own report.
 *
 * Exit code 0 was the whole receipt, and both CLIs exit 0 when they write
 * NOTHING: shadcn prints "Skipped 1 file" for a file that already exists,
 * BoardUI "Done. 0 files written." — and the receipt said "Instalado: button".
 * Formats as printed by shadcn@4.22 and boardui@latest on 2026-10-22.
 */
export function parseInstallFiles(kit: string, output: string): InstallFiles {
  const text = output.replace(ANSI, '');
  if (kit === 'boardui') {
    const written = BOARDUI_WRITTEN.exec(text);
    const skipped = BOARDUI_SKIPPED.exec(text);
    return {
      recognized: written !== null,
      created: [],
      updated: [],
      skipped: [],
      ...(written ? { writtenCount: Number(written[1]) } : {}),
      ...(skipped ? { skippedCount: Number(skipped[1]) } : {}),
    };
  }
  const lists: Record<'created' | 'updated' | 'skipped', string[]> = {
    created: [],
    updated: [],
    skipped: [],
  };
  let current: keyof typeof lists | null = null;
  let recognized = false;
  for (const line of text.split(/\r?\n/)) {
    const section = SHADCN_SECTION.exec(line);
    if (section) {
      current = (section[1] as string).toLowerCase() as keyof typeof lists;
      recognized = true;
      continue;
    }
    const entry = current ? LIST_ENTRY.exec(line) : null;
    if (entry && current) {
      lists[current].push((entry[1] as string).trim());
      continue;
    }
    current = null;
  }
  return { recognized, ...lists };
}

function wroteSomething(files: InstallFiles): boolean {
  return (
    files.created.length > 0 ||
    files.updated.length > 0 ||
    (files.writtenCount ?? 0) > 0
  );
}

function filesView(files: InstallFiles): UiKitInstallFilesView {
  return {
    created: files.created,
    updated: files.updated,
    skipped: files.skipped,
    ...(files.writtenCount !== undefined ? { writtenCount: files.writtenCount } : {}),
    ...(files.skippedCount !== undefined ? { skippedCount: files.skippedCount } : {}),
  };
}

/** One rule for both receipts: what may honestly be called installed. */
function installOutcome(run: UiKitRunResult, kit: string): {
  readonly files: InstallFiles;
  readonly installed: boolean;
  readonly nothingWritten: boolean;
} {
  const files = parseInstallFiles(kit, `${run.stdout}\n${run.stderr}`);
  if (!run.ok) return { files, installed: false, nothingWritten: false };
  // An output we cannot read keeps the old answer — the exit code — and says
  // so, rather than calling a real install a no-op.
  if (!files.recognized) return { files, installed: true, nothingWritten: false };
  const wrote = wroteSomething(files);
  return { files, installed: wrote, nothingWritten: !wrote };
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
    /** Which vendor ran: its report is read to know what was written. */
    readonly kit?: string;
  },
): UiKitInstallView {
  const recipe = options.recipe ?? null;
  const needsLicense = licenceNames(run, recipe);
  const outcome = installOutcome(run, options.kit ?? 'shadcn');
  return {
    ok: run.ok,
    installed: outcome.installed ? [...options.requested] : [],
    ...(outcome.files.recognized ? { files: filesView(outcome.files) } : {}),
    ...(outcome.nothingWritten ? { nothingWritten: true } : {}),
    ...(run.refusal ? { refusal: run.refusal } : {}),
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
  asked: {
    readonly kit: string;
    readonly items: readonly string[];
    /** Where the project imports kit components from (components.json). */
    readonly importAlias?: string;
  },
): Record<string, unknown> {
  const needsLicense = run.needsLicense ?? [];
  const outcome = installOutcome(run, asked.kit);
  const hints: string[] = [];
  if (run.hint) hints.push(run.hint);
  if (outcome.nothingWritten) {
    hints.push(
      'Nothing was written: those files already exist and were not overwritten. ' +
        'Pass overwrite: true to replace them, or use what is there.',
    );
  }
  return {
    ok: run.ok,
    kit: asked.kit,
    installed: outcome.installed ? [...asked.items] : [],
    ...(outcome.nothingWritten ? { alreadyPresent: [...asked.items] } : {}),
    ...(outcome.files.recognized
      ? { files: filesView(outcome.files) }
      : run.ok
        ? { filesUnverified: true }
        : {}),
    ...(outcome.installed
      ? {
          next:
            (asked.importAlias
              ? `Import it from ${asked.importAlias}/<item>. `
              : '') +
            'Style it with the project design contract (DESIGN.md tokens), not the vendor defaults.',
        }
      : {}),
    ...(run.refusal ? { refusal: run.refusal } : {}),
    ...(run.registryConflicts?.length ? { registryConflicts: run.registryConflicts } : {}),
    ...(run.unmappedRegistries?.length ? { unmappedRegistries: run.unmappedRegistries } : {}),
    ...(run.withheldRegistries?.length ? { withheldRegistries: run.withheldRegistries } : {}),
    ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    exitCode: run.code,
    output: `${run.stdout}\n${run.stderr}`.trim().slice(0, 20_000),
    ...(needsLicense.length > 0
      ? {
          needsLicense,
          licenceHint:
            `Those items are BoardUI Pro. The operator stores the licence in ${UI_KIT_SETTINGS_PATH}; the free items need no key.`,
        }
      : {}),
    ...(run.licenseState ? { licenseState: run.licenseState } : {}),
    ...(run.missingRegistryKeys.length > 0
      ? {
          missingRegistryKeys: run.missingRegistryKeys,
          registryHint:
            `Those registries have no token stored: ${UI_KIT_SETTINGS_PATH} → registries, or install from a keyless registry.`,
        }
      : {}),
  };
}
