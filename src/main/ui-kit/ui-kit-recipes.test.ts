import { describe, expect, it } from 'vitest';
import type { UiKitCandidate } from './ui-kit-pick';
import {
  findUiKitRecipe,
  matchRoleCandidate,
  resolveUiKitRecipe,
  UI_KIT_RECIPES,
} from './ui-kit-recipes';
import { boardUiTierOf } from './boardui-source';

function shadcn(slug: string, category = 'ui'): UiKitCandidate {
  return { kit: 'shadcn', slug, label: slug, category, tier: 'free' };
}
function boardui(slug: string, tier: 'free' | 'pro' = 'free'): UiKitCandidate {
  return { kit: 'boardui', slug, label: slug, category: 'block', tier };
}

/** A plausible slice of a live @shadcn listing. */
const SHADCN_CATALOG = [
  shadcn('button'),
  shadcn('sidebar'),
  shadcn('sidebar-with-collapsible-nested-groups'),
  shadcn('dashboard-01'),
  shadcn('chart-area-interactive'),
  shadcn('chart-bar-default'),
  shadcn('data-table'),
  shadcn('login-03'),
  shadcn('settings-form'),
];

describe('unknown tier is gated, never assumed free', () => {
  const role = {
    key: 'overview',
    label: 'Visão geral',
    match: ['dashboard'],
  } as const;

  function candidate(
    over: Partial<UiKitCandidate> = {},
  ): UiKitCandidate {
    return {
      kit: 'boardui',
      slug: 'dashboard-x',
      label: 'Dashboard',
      category: 'cached',
      tier: 'unknown',
      ...over,
    };
  }

  it('blocks an unknown BoardUI candidate without a licence', () => {
    // A slug the bundled snapshot never had is cached as `unknown`. Treating
    // it as usable let a recipe pick a Pro component and then had the real
    // gate refuse the whole batch, where a free fallback existed.
    const matched = matchRoleCandidate(role, [candidate()], { proLicensed: false });

    expect(matched.item).toBeNull();
    expect(matched.blocked?.slug).toBe('dashboard-x');
  });

  it('prefers a free sibling over the unknown one', () => {
    const matched = matchRoleCandidate(
      role,
      [candidate(), candidate({ slug: 'dashboard-free', tier: 'free' })],
      { proLicensed: false },
    );

    expect(matched.item?.slug).toBe('dashboard-free');
  });

  it('lets the unknown through once the licence is active', () => {
    const matched = matchRoleCandidate(role, [candidate()], { proLicensed: true });

    expect(matched.item?.slug).toBe('dashboard-x');
  });

  it('never gates shadcn, which has no licence to be missing', () => {
    // Guarding on tier alone would block every shadcn recipe the day some
    // path produced an `unknown` for it.
    const matched = matchRoleCandidate(
      role,
      [candidate({ kit: 'shadcn', category: 'registry-item' })],
      { proLicensed: false },
    );

    expect(matched.item?.slug).toBe('dashboard-x');
  });
});

describe('the recipe catalog', () => {
  it('ships a super admin and finds it by id', () => {
    expect(UI_KIT_RECIPES.map((recipe) => recipe.id)).toContain('super-admin');
    expect(findUiKitRecipe('Super-Admin')?.label).toBe('Super admin');
    expect(findUiKitRecipe('nope')).toBeNull();
  });
});

describe('matchRoleCandidate', () => {
  it('prefers an earlier keyword over a later one', () => {
    const role = { key: 'k', label: 'k', match: ['data-table', 'table'] };

    expect(matchRoleCandidate(role, [shadcn('settings-table'), shadcn('data-table')]).item?.slug)
      .toBe('data-table');
  });

  it('prefers the shortest slug among equals', () => {
    const role = { key: 'shell', label: 'shell', match: ['sidebar'] };

    expect(matchRoleCandidate(role, SHADCN_CATALOG).item?.slug).toBe('sidebar');
  });

  it('answers nothing when no keyword matches', () => {
    const role = { key: 'k', label: 'k', match: ['kanban'] };

    expect(matchRoleCandidate(role, SHADCN_CATALOG).item).toBeNull();
  });

  it('holds back a Pro match without a licence and names it', () => {
    const role = { key: 'charts', label: 'charts', match: ['chart'] };

    const result = matchRoleCandidate(role, [boardui('line-chart', 'pro')], { proLicensed: false });

    expect(result.item).toBeNull();
    expect(result.blocked?.slug).toBe('line-chart');
  });

  it('uses the Pro match once a licence is active', () => {
    const role = { key: 'charts', label: 'charts', match: ['chart'] };

    const result = matchRoleCandidate(role, [boardui('line-chart', 'pro')], { proLicensed: true });

    expect(result.item?.slug).toBe('line-chart');
    expect(result.blocked).toBeNull();
  });
});

describe('resolveUiKitRecipe — super admin on shadcn', () => {
  const resolved = resolveUiKitRecipe({
    recipe: findUiKitRecipe('super-admin')!,
    kit: 'shadcn',
    candidates: SHADCN_CATALOG,
  });

  it('fills every role from the live catalog', () => {
    expect(resolved.unresolved).toEqual([]);
    const byRole = Object.fromEntries(
      resolved.roles.map((entry) => [entry.role.key, entry.item?.slug ?? null]),
    );
    expect(byRole.shell).toBe('sidebar');
    expect(byRole.overview).toBe('dashboard-01');
    expect(byRole.table).toBe('data-table');
    expect(byRole.auth).toBe('login-03');
    expect(byRole.charts).toMatch(/^chart-/);
  });

  it('produces one install list in role order, without duplicates', () => {
    expect(resolved.install.length).toBe(new Set(resolved.install).size);
    expect(resolved.install[0]).toBe('sidebar');
    expect(resolved.install).toContain('data-table');
  });
});

describe('resolveUiKitRecipe — honest about what it could not fill', () => {
  it('reports a required role nothing matched', () => {
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('super-admin')!,
      kit: 'shadcn',
      candidates: [shadcn('button')],
    });

    expect(resolved.unresolved).toContain('shell');
    expect(resolved.unresolved).toContain('table');
    // `settings` is optional, so its absence is not a hole in the recipe.
    expect(resolved.unresolved).not.toContain('settings');
  });

  it('does not invent an item for an unmatched role', () => {
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('dashboard')!,
      kit: 'shadcn',
      candidates: [],
    });

    expect(resolved.install).toEqual([]);
    expect(resolved.roles.every((entry) => entry.item === null)).toBe(true);
  });
});

describe('resolveUiKitRecipe — BoardUI and the Pro gate', () => {
  const CATALOG = [
    boardui('sidebar'),
    boardui('stat-cards'),
    boardui('revenue-chart-card'),
    boardui('area-chart-card', 'pro'),
    boardui('data-table'),
    boardui('auth-card'),
    boardui('settings-modal'),
    boardui('finance-dashboard', 'pro'),
  ];

  it('prefers the known snapshot slug for each role', () => {
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('super-admin')!,
      kit: 'boardui',
      candidates: CATALOG,
    });

    const byRole = Object.fromEntries(
      resolved.roles.map((entry) => [entry.role.key, entry.item?.slug ?? null]),
    );
    expect(byRole.shell).toBe('sidebar');
    expect(byRole.overview).toBe('stat-cards');
    // No licence: the Pro chart card is skipped for the free one.
    expect(byRole.charts).toBe('revenue-chart-card');
    expect(byRole.auth).toBe('auth-card');
    expect(resolved.unresolved).toEqual([]);
  });

  it('reaches the Pro chart card with the licence that ships with Nexus', () => {
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('super-admin')!,
      kit: 'boardui',
      candidates: CATALOG,
      proLicensed: true,
    });

    expect(resolved.install).toContain('area-chart-card');
    expect(resolved.install).not.toContain('revenue-chart-card');
  });

  it('names only slugs the vendor actually publishes', () => {
    // `revenue-chart` / `orders-chart` were spelled from labels and did not
    // exist; every role slug has to be in the vendor-read snapshot.
    for (const recipe of UI_KIT_RECIPES) {
      for (const role of recipe.roles) {
        for (const slug of role.boardui ?? []) {
          expect(boardUiTierOf(slug), `${recipe.id}/${role.key}: ${slug}`).not.toBeNull();
        }
      }
    }
  });

  it('falls back to a free item and flags the role that wanted Pro', () => {
    const proOnly = [boardui('finance-dashboard', 'pro'), boardui('line-chart', 'pro')];
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('dashboard')!,
      kit: 'boardui',
      candidates: proOnly,
      proLicensed: false,
    });

    expect(resolved.install).toEqual([]);
    expect(resolved.licensedRoles).toContain('overview');
    expect(resolved.roles[0]?.needsLicense).toBe(true);
    expect(resolved.roles[0]?.blockedItem?.slug).toBe('finance-dashboard');
  });

  it('installs the Pro items once a licence is active', () => {
    const resolved = resolveUiKitRecipe({
      recipe: findUiKitRecipe('dashboard')!,
      kit: 'boardui',
      candidates: [boardui('finance-dashboard', 'pro'), boardui('line-chart', 'pro')],
      proLicensed: true,
    });

    expect(resolved.install).toContain('finance-dashboard');
    expect(resolved.licensedRoles).toEqual([]);
  });
});

describe('a demo is not the component', () => {
  it('prefers the real item over an (example) of it', () => {
    // The live @shadcn listing carries `button-demo (example)` next to
    // `button (ui)`; installing the demo looks like success and is wrong.
    const role = { key: 'auth', label: 'auth', match: ['login'] };
    const candidates = [
      shadcn('login-demo', 'example'),
      shadcn('login-03'),
    ];

    expect(matchRoleCandidate(role, candidates).item?.slug).toBe('login-03');
  });

  it('still answers with a demo when that is all there is', () => {
    const role = { key: 'auth', label: 'auth', match: ['login'] };

    expect(
      matchRoleCandidate(role, [shadcn('login-demo', 'example')]).item?.slug,
    ).toBe('login-demo');
  });
});
