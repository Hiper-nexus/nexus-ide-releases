import { describe, expect, it } from 'vitest';
import {
  agentInstallReceipt,
  installViewFromItemPlan,
  installViewFromPlan,
  installViewFromRun,
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
    expect(String(receipt.licenceHint)).toContain('Settings → UI kits');
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
