import { describe, expect, it } from 'vitest';
import type { UiKitCandidate } from './ui-kit-pick';
import {
  findUiKitRecipe,
  matchRoleCandidate,
  resolveUiKitRecipe,
  UI_KIT_RECIPES,
} from './ui-kit-recipes';

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
    boardui('revenue-chart'),
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
    expect(byRole.charts).toBe('revenue-chart');
    expect(byRole.auth).toBe('auth-card');
    expect(resolved.unresolved).toEqual([]);
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
