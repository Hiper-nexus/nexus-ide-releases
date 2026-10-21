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
