// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DESIGN_CHARTER } from './design-charter';
import { composeDesignCharter } from './design-profile';
import { operatorDesignContext } from './workspace-design-rule';

/**
 * The charter is the ONE deterministic delivery of the UI kit, and it is why
 * "both paths use it" is a fact rather than a hope:
 *
 * - every mission worker whose task produces UI gets it
 *   (design-profile → worker-handoff-contract), and
 * - a direct "+ Pane" gets it on the first UI request of the session
 *   (hook-delegate-endpoint → designContextFor → workspace-design-rule).
 *
 * Neither depends on the Jev firing, on a skill being suggested, or on a
 * squad being governed. These assertions exist so an edit to the charter
 * cannot quietly drop the kit and leave both paths back to hand-written
 * components with nobody noticing.
 */

describe('the design charter carries the UI kit', () => {
  it('names both kits', () => {
    expect(DESIGN_CHARTER).toContain('shadcn/ui');
    expect(DESIGN_CHARTER).toContain('BoardUI');
  });

  it('names the tool for each step an agent has to take', () => {
    for (const tool of [
      'nexus_ui_kit_catalog',
      'nexus_ui_kit_source',
      'nexus_ui_kit_add',
      'nexus_ui_kit_recipe',
    ]) {
      expect(DESIGN_CHARTER).toContain(tool);
    }
  });

  it('tells the agent to install instead of re-typing a primitive', () => {
    expect(DESIGN_CHARTER).toMatch(/Install the component, don't re-type it/);
    expect(DESIGN_CHARTER).toMatch(/Never hand-write a button/);
  });

  it('resolves the contradiction: take the code, reject the look', () => {
    // Without this the agent reads "no default shadcn" and concludes the kit
    // itself is banned — the exact misreading the house rules invite.
    expect(DESIGN_CHARTER).toMatch(/kit's CODE and reject its LOOK/);
    expect(DESIGN_CHARTER).toContain('is about the visual');
  });

  it('says the free half needs no key, so a missing licence never stalls UI work', () => {
    expect(DESIGN_CHARTER).toContain('the free half needs no key');
    expect(DESIGN_CHARTER).toMatch(/falls back to a free equivalent/);
  });

  it('survives the neutral profile byte for byte, kit included', () => {
    // The neutral profile returns the charter untouched; if that ever changed
    // the kit guidance would be the first thing to vanish silently.
    expect(composeDesignCharter()).toContain('nexus_ui_kit_recipe');
  });

  it('still carries the anti-slop bans it was written for', () => {
    expect(DESIGN_CHARTER).toContain('Emoji as UI icons');
    expect(DESIGN_CHARTER).toContain('Glassmorphism');
  });
});

describe('the two paths that actually deliver it', () => {
  const roots: string[] = [];
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'nexus-ui-kit-charter-'));
    roots.push(root);
    return root;
  }
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  );

  it('reaches a hand-opened "+ Pane" on a UI request', () => {
    // This is the operator's own pane: no spawn prompt, no squad, no mission.
    // The UserPromptSubmit hook injects this when the message asks for UI work.
    const text = operatorDesignContext('Crie a tela de ajustes do app', workspace(), {
      catalogDir: join(workspace(), 'missing'),
      charter: DESIGN_CHARTER,
    });

    expect(text).toContain('nexus_ui_kit_catalog');
    expect(text).toContain('nexus_ui_kit_recipe');
    expect(text).toContain('shadcn/ui');
  });

  it('stays out of a message that is a bug report, not a UI request', () => {
    // The charter is not free: it must not ride along on every message.
    const text = operatorDesignContext(
      'a tela congela quando eu fecho o pane',
      workspace(),
      { catalogDir: join(workspace(), 'missing'), charter: DESIGN_CHARTER },
    );

    expect(text).toBeNull();
  });
});
