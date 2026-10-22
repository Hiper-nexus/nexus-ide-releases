import { describe, expect, it } from 'vitest';
import {
  agentInstallReceipt,
  installViewFromItemPlan,
  installViewFromPlan,
  installViewFromRun,
  parseInstallFiles,
} from './ui-kit-install-view';
import type { UiKitRunResult } from './ui-kit-service';

function run(over: Partial<UiKitRunResult> = {}): UiKitRunResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    code: 0,
    missingRegistryKeys: [],
    ...over,
  };
}

describe('installViewFromRun', () => {
  it('tells the operator a direct install was refused for want of a licence', () => {
    // The regression this module exists for: the direct path forwarded only
    // ok/installed/missingRegistryKeys, so the panel said "A instalação
    // falhou." and never mentioned the licence that would fix it.
    const view = installViewFromRun(
      run({
        ok: false,
        stderr: 'BoardUI Pro licence required for: template-home-dashboard.',
        code: 1,
        needsLicense: ['template-home-dashboard'],
        licenseState: 'absent',
      }),
      { requested: ['template-home-dashboard'] },
    );

    expect(view).toMatchObject({
      ok: false,
      installed: [],
      needsLicense: ['template-home-dashboard'],
      licenseState: 'absent',
    });
  });

  it('distinguishes "no key stored" from "could not ask the vendor"', () => {
    const view = installViewFromRun(
      run({ ok: false, code: 1, needsLicense: ['x'], licenseState: 'unknown' }),
      { requested: ['x'] },
    );

    expect(view.licenseState).toBe('unknown');
  });

  it('merges the recipe roles with the items the run itself refused, once each', () => {
    const view = installViewFromRun(
      run({ ok: false, code: 1, needsLicense: ['charts', 'table'], licenseState: 'absent' }),
      {
        requested: ['sidebar'],
        recipe: { install: ['sidebar'], unresolved: [], licensedRoles: ['charts'] },
      },
    );

    expect(view.needsLicense).toEqual(['charts', 'table']);
  });

  it('reports installed only when the run succeeded', () => {
    expect(
      installViewFromRun(run({ stdout: 'added' }), { requested: ['button', 'card'] }).installed,
    ).toEqual(['button', 'card']);
    expect(
      installViewFromRun(run({ ok: false, code: 1 }), { requested: ['button'] }).installed,
    ).toEqual([]);
  });

  it('omits the licence fields entirely when no licence was involved', () => {
    const view = installViewFromRun(run(), { requested: ['button'] });

    expect(view.needsLicense).toBeUndefined();
    expect(view.licenseState).toBeUndefined();
    expect(view.unresolved).toBeUndefined();
  });

  it('caps the vendor output it passes to the renderer', () => {
    const view = installViewFromRun(run({ stdout: 'x'.repeat(20_000) }), {
      requested: [],
    });

    expect(view.output).toHaveLength(8_000);
  });
});

describe('installViewFromItemPlan', () => {
  it('reports what a dry run WOULD install, with nothing installed', () => {
    const view = installViewFromItemPlan({
      install: ['button'],
      needsLicense: [],
    });

    expect(view).toEqual({ ok: true, installed: ['button'] });
  });

  it('is not ok when the caller named something the licence refuses', () => {
    const view = installViewFromItemPlan({
      install: ['button'],
      needsLicense: ['template-home-dashboard'],
      licenseState: 'absent',
    });

    expect(view).toMatchObject({
      ok: false,
      installed: ['button'],
      needsLicense: ['template-home-dashboard'],
      licenseState: 'absent',
    });
    // NOT `unresolved`: the item exists, it needs a key. Saying "no catalogue
    // item for it" would send the operator looking for the wrong thing.
    expect(view.unresolved).toBeUndefined();
  });
});

describe('installViewFromPlan', () => {
  it('claims no licence verdict, because nothing asked the vendor', () => {
    const view = installViewFromPlan({
      install: ['sidebar'],
      unresolved: [],
      licensedRoles: ['charts'],
    });

    expect(view).toEqual({
      ok: true,
      installed: ['sidebar'],
      unresolved: [],
      needsLicense: ['charts'],
    });
    expect(view.licenseState).toBeUndefined();
  });

  it('is not ok while a required role has no item at all', () => {
    const view = installViewFromPlan({
      install: [],
      unresolved: ['shell'],
      licensedRoles: [],
    });

    expect(view.ok).toBe(false);
    expect(view.needsLicense).toBeUndefined();
  });
});

describe('agentInstallReceipt', () => {
  it('names what the licence refused, instead of burying it in output', () => {
    // The settings IPC and the BoardUI tool both carry the gate's verdict;
    // this path left the refusal only in free-form `output`, so a model could
    // neither name the blocked items nor tell "no key stored" from "vendor
    // unreachable".
    const receipt = agentInstallReceipt(
      run({
        ok: false,
        code: 1,
        stderr: 'BoardUI Pro licence required for: template-home-dashboard.',
        needsLicense: ['template-home-dashboard'],
        licenseState: 'absent',
      }),
      { kit: 'boardui', items: ['template-home-dashboard'] },
    );

    expect(receipt).toMatchObject({
      ok: false,
      kit: 'boardui',
      installed: [],
      needsLicense: ['template-home-dashboard'],
      licenseState: 'absent',
    });
    expect(String(receipt.licenceHint)).toContain('Configurações › Biblioteca › Kits de UI');
  });

  it('distinguishes an unreachable vendor from a missing key', () => {
    const receipt = agentInstallReceipt(
      run({ ok: false, code: 1, needsLicense: ['x'], licenseState: 'unknown' }),
      { kit: 'boardui', items: ['x'] },
    );

    expect(receipt.licenseState).toBe('unknown');
  });

  it('stays quiet about the licence when none was involved', () => {
    const receipt = agentInstallReceipt(run({ stdout: 'added' }), {
      kit: 'shadcn',
      items: ['button'],
    });

    expect(receipt).toMatchObject({ ok: true, installed: ['button'], exitCode: 0 });
    expect(receipt.needsLicense).toBeUndefined();
    expect(receipt.licenseState).toBeUndefined();
    expect(receipt.licenceHint).toBeUndefined();
  });
});

/** Real outputs, captured from shadcn@4.22 and boardui@latest on 22/10/2026. */
const SHADCN_CREATED =
  '- Checking registry.\n✔ Checking registry.\n- Installing dependencies.\n✔ Installing dependencies.\n' +
  '- Updating files.\n✔ Created 1 file:\n  - src/components/ui/button.tsx\n';
const SHADCN_MIXED =
  '- Checking registry.\n✔ Checking registry.\n- Updating files.\n✔ Created 1 file:\n' +
  '  - src/components/ui/card.tsx\n' +
  'ℹ Skipped 1 file: (files might be identical, use --overwrite to overwrite)\n' +
  '  - src/components/ui/button.tsx\n';
const SHADCN_ALL_SKIPPED =
  '- Checking registry.\n✔ Checking registry.\n- Updating files.\n' +
  'ℹ Skipped 1 file: (files might be identical, use --overwrite to overwrite)\n' +
  '  - src/components/ui/button.tsx\n';
const BOARDUI_NOTHING =
  '- Resolving components...\n✔ Resolved 6 items: cx, directional-icon, theme, typography, globals, button\n' +
  '  skipped 6 existing files\n\nNote: import the BoardUI styles in your root layout or global css:\n' +
  '  import "@/styles/globals.css";\n\nDone. 0 files written.\n';
const BOARDUI_WROTE =
  '✔ Resolved 9 items: cx, theme, globals, stat-cards\n  skipped 2 existing files\n\nDone. 7 files written.\n';

describe('parseInstallFiles — what the vendor actually wrote', () => {
  it('reads shadcn created, updated and skipped lists', () => {
    expect(parseInstallFiles('shadcn', SHADCN_MIXED)).toEqual({
      recognized: true,
      created: ['src/components/ui/card.tsx'],
      updated: [],
      skipped: ['src/components/ui/button.tsx'],
    });
  });

  it('reads BoardUI counts', () => {
    expect(parseInstallFiles('boardui', BOARDUI_WROTE)).toMatchObject({
      recognized: true,
      writtenCount: 7,
      skippedCount: 2,
    });
    expect(parseInstallFiles('boardui', BOARDUI_NOTHING)).toMatchObject({
      recognized: true,
      writtenCount: 0,
      skippedCount: 6,
    });
  });

  it('admits when it does not recognise the output', () => {
    expect(parseInstallFiles('shadcn', 'something else entirely').recognized).toBe(false);
  });
});

describe('"Instalado" only when something was written', () => {
  it('lists nothing as installed when every file already existed', () => {
    // Review 22/10: an existing file is skipped and the receipt still said
    // "Instalado: button".
    const receipt = agentInstallReceipt(run({ stdout: SHADCN_ALL_SKIPPED }), {
      kit: 'shadcn',
      items: ['button'],
    });

    expect(receipt.installed).toEqual([]);
    expect(receipt.alreadyPresent).toEqual(['button']);
    expect(receipt.files).toMatchObject({ skipped: ['src/components/ui/button.tsx'] });
    expect(String(receipt.hint)).toMatch(/overwrite: true/);
  });

  it('reports the files a real install wrote', () => {
    const receipt = agentInstallReceipt(run({ stdout: SHADCN_CREATED }), {
      kit: 'shadcn',
      items: ['button'],
      importAlias: '@/components/ui',
    });

    expect(receipt.installed).toEqual(['button']);
    expect(receipt.files).toMatchObject({ created: ['src/components/ui/button.tsx'] });
    expect(String(receipt.next)).toMatch(/@\/components\/ui/);
  });

  it('says so for BoardUI when zero files were written', () => {
    const receipt = agentInstallReceipt(run({ stdout: BOARDUI_NOTHING }), {
      kit: 'boardui',
      items: ['button'],
    });

    expect(receipt.installed).toEqual([]);
    expect(receipt.alreadyPresent).toEqual(['button']);
  });

  it('keeps the old answer, flagged, when the output is not recognised', () => {
    const receipt = agentInstallReceipt(run({ stdout: 'odd output' }), {
      kit: 'shadcn',
      items: ['button'],
    });

    expect(receipt.installed).toEqual(['button']);
    expect(receipt.filesUnverified).toBe(true);
  });

  it('carries the registry findings it used to drop', () => {
    const receipt = agentInstallReceipt(
      run({
        stdout: SHADCN_CREATED,
        registryConflicts: ['@acme'],
        unmappedRegistries: ['@team'],
        withheldRegistries: ['@other'],
      }),
      { kit: 'shadcn', items: ['button'] },
    );

    expect(receipt).toMatchObject({
      registryConflicts: ['@acme'],
      unmappedRegistries: ['@team'],
      withheldRegistries: ['@other'],
    });
  });

  it('passes a refusal Main made before running, with its hint', () => {
    const receipt = agentInstallReceipt(
      run({
        ok: false,
        code: null,
        refusal: 'components_json_missing',
        hint: "Run nexus_ui_kit_run { command: 'init' } first.",
      }),
      { kit: 'shadcn', items: ['button'] },
    );

    expect(receipt).toMatchObject({ ok: false, refusal: 'components_json_missing' });
    expect(String(receipt.hint)).toMatch(/init/);
  });

  it('tells the panel nothing was written, instead of "Instalado"', () => {
    const view = installViewFromRun(run({ stdout: SHADCN_ALL_SKIPPED }), { requested: ['button'] });

    expect(view.installed).toEqual([]);
    expect(view.nothingWritten).toBe(true);
    expect(view.files?.skipped).toEqual(['src/components/ui/button.tsx']);
  });
});
