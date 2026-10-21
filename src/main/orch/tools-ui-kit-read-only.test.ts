// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `nexus_ui_kit_catalog` and `nexus_ui_kit_source` are classified `read-only`
 * in mcp-effect-policy, which is what lets a reviewer, a readOnly worker or an
 * unconfirmed voice call reach them. That classification is only honest if
 * they cannot cause code execution.
 *
 * They could: running `npx` in the PROJECT's directory means npm reads a
 * `.npmrc` from that cwd, so the repository — untrusted content by this
 * project's own threat model — could point `registry=` at a host of its choice
 * and decide which `shadcn` package gets downloaded and run.
 *
 * So the test makes spawning fatal. Any path that tries, from either handler,
 * fails here instead of in a user's repo.
 */
vi.mock('node:child_process', () => {
  const explode = () => {
    throw new Error('a read-only UI-kit tool must never spawn a process');
  };
  return { spawn: explode, spawnSync: explode, exec: explode, execFile: explode };
});

/**
 * And it must not reach the Jev either. `pickUiKit` consults it when the
 * surface is on and a credential exists — an HTTP request carrying the task
 * text to a third party, plus a write to the local decision log — and the
 * spawn guard above never saw it, because the Jev travels by fetch. A
 * reviewer, a readOnly worker and an unconfirmed voice call all reach this
 * tool, and none of them may cause egress.
 *
 * The surface and the credential are forced ON here. Without that this guard
 * proved nothing: `pickUiKit` returns the heuristic before asking anything
 * when either is missing, which is the normal state of a test machine — so
 * the un-fixed code passed. And a throwing `judge` is not enough either,
 * because `pickUiKit` fails open by design; what the assertion reads is
 * whether it was CALLED.
 */
const jev = vi.hoisted(() => ({
  judge: vi.fn(() => {
    throw new Error('a read-only UI-kit tool must never call the Jev');
  }),
}));
vi.mock('../jev/jev-client', () => ({
  judge: jev.judge,
  capText: (value: string) => value,
}));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: () => true }));
vi.mock('../decision-models/decision-availability', () => ({
  hasDecisionCredential: () => true,
}));

const { buildUiKitTools } = await import('./tools-ui-kit');
const { setUiKitCacheRootResolver, writeCachedItem } = await import(
  '../ui-kit/ui-kit-cache'
);

let root = '';
const ctx = {} as Parameters<ReturnType<typeof buildUiKitTools>[0]['handler']>[1];

function tool(name: string) {
  const found = buildUiKitTools().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool not built: ${name}`);
  return found;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-ro-'));
  setUiKitCacheRootResolver(() => root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nexus_ui_kit_catalog is read-only in fact, not only by label', () => {
  it("serves BoardUI's whole catalog with no process at all", async () => {
    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'boardui' },
      ctx,
    )) as { items: unknown[]; offline: boolean; hint: string };

    expect(out.items).toHaveLength(69);
    expect(out.offline).toBe(true);
    expect(out.hint).toContain('ships with Nexus');
  });

  it('lists only what was downloaded for shadcn, and names the effectful way out', async () => {
    writeCachedItem(
      { kit: 'shadcn', slug: 'button', payload: 'source', source: 'shadcn view' },
      { rootDir: root },
    );

    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'shadcn' },
      ctx,
    )) as { items: { slug: string }[]; hint: string; recipes: unknown[] };

    expect(out.items.map((entry) => entry.slug)).toEqual(['button']);
    expect(out.hint).toContain("nexus_ui_kit_run { command: 'search' }");
    // The recipes are static, so the offline view still offers the super admin.
    expect(out.recipes.length).toBeGreaterThan(0);
  });

  it('honours cachedOnly instead of returning the whole bundled snapshot', async () => {
    // The option was declared and never read, so a caller asking to work from
    // downloaded items only got BoardUI's 69 bundled entries back with
    // `cached: false` on almost all of them.
    writeCachedItem(
      { kit: 'boardui', slug: 'button', payload: 'source', source: 'boardui' },
      { rootDir: root },
    );

    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'boardui', cachedOnly: true },
      ctx,
    )) as { items: { slug: string; cached: boolean }[]; cachedOnly: boolean };

    expect(out.cachedOnly).toBe(true);
    expect(out.items.map((entry) => entry.slug)).toEqual(['button']);
    expect(out.items.every((entry) => entry.cached)).toBe(true);
  });

  it('does not recommend an item it was told is out of reach', async () => {
    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'shadcn', cachedOnly: true, task: 'a revenue dashboard with charts' },
      ctx,
    )) as { items: unknown[]; recommendation: { item: string | null } };

    // Nothing is cached in this test, so there is nothing to suggest — and a
    // BoardUI item from the bundled snapshot would not be downloaded either.
    expect(out.items).toEqual([]);
    expect(out.recommendation.item).toBeNull();
  });

  it('recommends with the offline rule, never the Jev', async () => {
    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'boardui', task: 'a revenue dashboard with charts' },
      ctx,
    )) as {
      recommendation: { decidedBy: string; offlineRuleOnly: boolean; kit: string | null };
    };

    // The Jev is reachable in this test (surface and credential forced on),
    // so a call would be a real egress in someone's repo. It must not happen.
    expect(jev.judge).not.toHaveBeenCalled();
    expect(out.recommendation.decidedBy).toBe('heuristic');
    expect(out.recommendation.offlineRuleOnly).toBe(true);
    expect(out.recommendation.kit).toBe('boardui');
  });

  it('recommends without probing the licence, and says it did not', async () => {
    const out = (await tool('nexus_ui_kit_catalog').handler(
      { kit: 'boardui', task: 'a revenue dashboard with charts' },
      ctx,
    )) as { recommendation: { licenceNotChecked: boolean; kit: string | null } };

    // Asking the vendor whether Pro is active would spawn its MCP server.
    expect(out.recommendation.licenceNotChecked).toBe(true);
    expect(out.recommendation.kit).toBe('boardui');
  });
});

describe('nexus_ui_kit_source is read-only in fact', () => {
  it('returns a cached item', async () => {
    writeCachedItem(
      { kit: 'shadcn', slug: 'button', payload: 'export const Button = 1', source: 's' },
      { rootDir: root },
    );

    const out = (await tool('nexus_ui_kit_source').handler(
      { kit: 'shadcn', slug: 'button' },
      ctx,
    )) as { cached: boolean; source: string };

    expect(out.cached).toBe(true);
    expect(out.source).toBe('export const Button = 1');
  });

  it('hands back the effectful call instead of fetching an item it lacks', async () => {
    const out = (await tool('nexus_ui_kit_source').handler(
      { kit: 'shadcn', slug: 'sidebar' },
      ctx,
    )) as { cached: boolean; source: null; hint: string };

    expect(out.cached).toBe(false);
    expect(out.source).toBeNull();
    expect(out.hint).toContain("nexus_ui_kit_run { command: 'view', items: ['sidebar'] }");
  });

  it('refuses a slug shaped to escape the cache directory', async () => {
    await expect(
      tool('nexus_ui_kit_source').handler({ kit: 'shadcn', slug: '../../etc/passwd' }, ctx),
    ).rejects.toThrow();
  });
});

describe('the Jev decides on the EFFECTFUL surface only', () => {
  it('keeps nexus_ui_kit_add out of the read-only class', async () => {
    // The whole point of moving the pick to the install path: if this tool
    // were ever reclassified, the task text would reach a third party from a
    // reviewer, a readOnly worker or an unconfirmed voice call again. This
    // asserts the classification itself, not a comment about it.
    const policy = await import('./mcp-effect-policy');

    expect(policy.effectPolicyForTool('nexus_ui_kit_add')).not.toBe('read-only');
    expect(policy.isToolAllowedForReadOnlyContext('nexus_ui_kit_add')).toBe(false);
    // And the two that DO carry the task text offline stay read-only.
    expect(policy.effectPolicyForTool('nexus_ui_kit_catalog')).toBe('read-only');
    expect(policy.effectPolicyForTool('nexus_ui_kit_source')).toBe('read-only');
  });

  it('offers `task` on the install tool and nowhere read-only', () => {
    const named = (name: string) =>
      buildUiKitTools().find((entry) => entry.name === name)?.inputSchema as {
        properties?: Record<string, unknown>;
      };

    expect(named('nexus_ui_kit_add').properties?.task).toBeTruthy();
    // The read-only catalogue still takes a `task`, but it answers with the
    // offline rule — the guard above is what proves it never calls the Jev.
    expect(named('nexus_ui_kit_source').properties?.task).toBeUndefined();
  });
});

describe('the licence lifecycle stays with the operator', () => {
  it('refuses deactivate_license without touching the vendor, and names Settings', async () => {
    // Releasing the licence spends a vendor activation and wipes a key the
    // operator bought. Going through the vendor from here would also leave
    // the key in the vault while the vendor had released it, because only
    // `deactivateBoardUiLicense` — the panel's path — forgets it.
    const out = (await tool('nexus_ui_kit_boardui').handler(
      { tool: 'deactivate_license' },
      ctx,
    )) as { ok: boolean; reason: string; hint: string };

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('operator_action');
    expect(out.hint).toContain('Settings → UI kits');
  });

  it('does not advertise deactivation as something it performs', () => {
    const boardui = buildUiKitTools().find((entry) => entry.name === 'nexus_ui_kit_boardui');

    expect(boardui?.description).toContain("deactivate_license is the operator's own");
  });
});

describe('the agent surface offers no write destination', () => {
  /**
   * Three rounds of review found three ways past string checks on a
   * caller-chosen write path: Windows drive-relative (`C:foo`), a symlinked
   * ancestor, and a dangling link that `mkdir -p` then creates outside. The
   * fix was to stop accepting the destination, not to patch a fourth. This
   * test is what keeps the option from drifting back in.
   */
  const FORBIDDEN = ['path', 'dir', 'output', 'registry', 'projectDir', 'cwd', 'outDir'];

  it('declares no destination property on any tool', () => {
    const offenders: string[] = [];
    for (const entry of buildUiKitTools()) {
      const schema = entry.inputSchema as { properties?: Record<string, unknown> };
      for (const key of Object.keys(schema.properties ?? {})) {
        if (FORBIDDEN.includes(key)) offenders.push(`${entry.name}.${key}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('refuses an item that is a local path, the last caller-chosen one', async () => {
    const add = buildUiKitTools().find((entry) => entry.name === 'nexus_ui_kit_add');

    await expect(
      add?.handler({ kit: 'shadcn', items: ['registry/button.json'] }, ctx),
    ).rejects.toThrow(/not installable from here/);
    await expect(
      buildUiKitTools()
        .find((entry) => entry.name === 'nexus_ui_kit_run')
        ?.handler({ command: 'view', items: ['registry/button.json'] }, ctx),
    ).rejects.toThrow(/not installable from here/);
  });

  it('still offers the tools the kit is for', () => {
    expect(buildUiKitTools().map((entry) => entry.name).sort()).toEqual([
      'nexus_ui_kit_add',
      'nexus_ui_kit_boardui',
      'nexus_ui_kit_catalog',
      'nexus_ui_kit_recipe',
      'nexus_ui_kit_run',
      'nexus_ui_kit_source',
    ]);
  });
});
