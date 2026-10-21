import type { UiKitId } from './ui-kit-cli';
import type { UiKitCandidate } from './ui-kit-pick';

/**
 * Ready-made assemblies: "a super admin", "a dashboard with charts".
 *
 * This is the part that actually saves the day. A client admin is never one
 * component — it is a shell, a sidebar, an overview with charts, a data table,
 * an auth screen and a settings page. Installing those one by one is six
 * decisions and six commands; a recipe is one.
 *
 * A recipe names ROLES, not slugs. Hard-coding `dashboard-01` would be
 * inventing registry names that drift the moment a vendor renames a block, so
 * each role carries the keywords that identify it and is resolved against the
 * LIVE catalog (one listing call, matched locally). A role that nothing matches
 * comes back unresolved and is reported — never silently dropped, and never
 * filled with a guess.
 */

export interface UiKitRecipeRole {
  readonly key: string;
  readonly label: string;
  /** Keywords matched against live slugs, best first. */
  readonly match: readonly string[];
  /** Known BoardUI snapshot slugs that serve this role, best first. */
  readonly boardui?: readonly string[];
  /** A recipe is still useful without an optional role. */
  readonly optional?: boolean;
}

export interface UiKitRecipe {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly roles: readonly UiKitRecipeRole[];
}

export const UI_KIT_RECIPES: readonly UiKitRecipe[] = [
  {
    id: 'super-admin',
    label: 'Super admin',
    description:
      'The whole back office: app shell with sidebar, overview with charts, ' +
      'a data table, an auth screen and a settings page.',
    roles: [
      {
        key: 'shell',
        label: 'Shell and sidebar',
        match: ['sidebar', 'shell', 'app-sidebar', 'nav'],
        boardui: ['sidebar'],
      },
      {
        key: 'overview',
        label: 'Overview with stats',
        match: ['dashboard', 'overview', 'stat', 'metric'],
        boardui: ['stat-cards'],
      },
      {
        key: 'charts',
        label: 'Charts',
        match: ['chart-area', 'chart-bar', 'chart-line', 'chart'],
        boardui: ['revenue-chart', 'orders-chart'],
      },
      {
        key: 'table',
        label: 'Data table',
        match: ['data-table', 'table', 'datagrid', 'data-grid'],
        boardui: ['data-table', 'data-grid'],
      },
      {
        key: 'auth',
        label: 'Auth screen',
        match: ['login', 'signin', 'sign-in', 'auth'],
        boardui: ['auth-card'],
      },
      {
        key: 'settings',
        label: 'Settings page',
        match: ['settings', 'profile', 'account', 'form'],
        boardui: ['settings-modal'],
        optional: true,
      },
    ],
  },
  {
    id: 'dashboard',
    label: 'Dashboard with charts',
    description: 'An overview surface: stat cards, charts and a table.',
    roles: [
      {
        key: 'overview',
        label: 'Stat cards',
        match: ['dashboard', 'stat', 'metric', 'overview'],
        boardui: ['stat-cards'],
      },
      {
        key: 'charts',
        label: 'Charts',
        match: ['chart-area', 'chart-bar', 'chart-line', 'chart'],
        boardui: ['revenue-chart', 'orders-chart'],
      },
      {
        key: 'table',
        label: 'Data table',
        match: ['data-table', 'table'],
        boardui: ['data-table'],
        optional: true,
      },
    ],
  },
  {
    id: 'auth',
    label: 'Sign in and sign up',
    description: 'The authentication screens on their own.',
    roles: [
      {
        key: 'login',
        label: 'Sign in',
        match: ['login', 'signin', 'sign-in'],
        boardui: ['auth-card'],
      },
      {
        key: 'form',
        label: 'Form primitives',
        match: ['form', 'input', 'label', 'button'],
        boardui: ['input', 'button'],
        optional: true,
      },
    ],
  },
];

export function findUiKitRecipe(id: string): UiKitRecipe | null {
  const normalized = id.trim().toLowerCase();
  return UI_KIT_RECIPES.find((recipe) => recipe.id === normalized) ?? null;
}

export interface ResolvedRecipeRole {
  readonly role: UiKitRecipeRole;
  readonly item: UiKitCandidate | null;
  /** Set when the only match for the role needs a Pro licence. */
  readonly needsLicense: boolean;
  readonly blockedItem?: UiKitCandidate;
}

export interface ResolvedRecipe {
  readonly recipe: UiKitRecipe;
  readonly kit: UiKitId;
  readonly roles: readonly ResolvedRecipeRole[];
  /** Items to install, in role order, de-duplicated. */
  readonly install: readonly string[];
  /** Required roles nothing matched. Reported, never guessed. */
  readonly unresolved: readonly string[];
  /** Roles that would need a BoardUI Pro licence. */
  readonly licensedRoles: readonly string[];
}

/**
 * Pick the best candidate for a role.
 *
 * Earlier keywords win, and among equals the SHORTEST slug wins: in a registry
 * `sidebar` beats `sidebar-with-collapsible-nested-groups` as the thing a
 * recipe should install by default.
 */
/**
 * Whether a candidate is behind the licence.
 *
 * `unknown` is gated, not free — the same rule the install gate already
 * applies. A slug the bundled snapshot never had is cached as `unknown`, so
 * treating it as usable let a recipe pick a Pro component and then had
 * `installItems` refuse the whole batch at the real gate: the operator got a
 * failure where a free fallback was available.
 *
 * Pro is a BoardUI concept. shadcn has no licence to be missing, and its items
 * are `free` by construction, so gating by tier alone would one day block
 * every shadcn recipe the moment some path produced an `unknown`.
 */
function candidateNeedsLicense(
  candidate: UiKitCandidate,
  proLicensed: boolean | undefined,
): boolean {
  if (proLicensed === true) return false;
  return candidate.kit === 'boardui' && candidate.tier !== 'free';
}

export function matchRoleCandidate(
  role: UiKitRecipeRole,
  candidates: readonly UiKitCandidate[],
  options: { readonly proLicensed?: boolean } = {},
): { item: UiKitCandidate | null; blocked: UiKitCandidate | null } {
  const usable: UiKitCandidate[] = [];
  const blocked: UiKitCandidate[] = [];

  for (const keyword of role.match) {
    const hits = candidates.filter((entry) =>
      entry.slug.toLowerCase().includes(keyword),
    );
    if (hits.length === 0) continue;
    // A demo is not the component. The real @shadcn listing carries
    // `(example)` next to items like `button-demo`, and installing one of
    // those instead of `button` looks like success and is wrong.
    const sorted = [...hits].sort((a, b) => {
      const demoA = a.category === 'example' ? 1 : 0;
      const demoB = b.category === 'example' ? 1 : 0;
      if (demoA !== demoB) return demoA - demoB;
      return a.slug.length - b.slug.length;
    });
    for (const hit of sorted) {
      if (candidateNeedsLicense(hit, options.proLicensed)) blocked.push(hit);
      else usable.push(hit);
    }
    if (usable.length > 0) break;
  }

  return {
    item: usable[0] ?? null,
    blocked: usable.length === 0 ? (blocked[0] ?? null) : null,
  };
}

/**
 * Resolve a whole recipe against a live catalog.
 *
 * For BoardUI the role's known snapshot slugs are preferred, because that
 * catalog is structured and the slugs are already known; the live list only
 * adds to it.
 */
export function resolveUiKitRecipe(input: {
  readonly recipe: UiKitRecipe;
  readonly kit: UiKitId;
  readonly candidates: readonly UiKitCandidate[];
  readonly proLicensed?: boolean;
}): ResolvedRecipe {
  const roles: ResolvedRecipeRole[] = [];
  const install: string[] = [];
  const unresolved: string[] = [];
  const licensedRoles: string[] = [];

  for (const role of input.recipe.roles) {
    let item: UiKitCandidate | null = null;
    let blocked: UiKitCandidate | null = null;

    if (input.kit === 'boardui' && role.boardui) {
      for (const slug of role.boardui) {
        const found = input.candidates.find(
          (entry) => entry.kit === 'boardui' && entry.slug === slug,
        );
        if (!found) continue;
        if (candidateNeedsLicense(found, input.proLicensed)) {
          blocked = blocked ?? found;
          continue;
        }
        item = found;
        break;
      }
    }

    if (!item) {
      const matched = matchRoleCandidate(
        role,
        input.candidates.filter((entry) => entry.kit === input.kit),
        { ...(input.proLicensed !== undefined ? { proLicensed: input.proLicensed } : {}) },
      );
      item = matched.item;
      blocked = blocked ?? matched.blocked;
    }

    roles.push({
      role,
      item,
      needsLicense: !item && Boolean(blocked),
      ...(blocked ? { blockedItem: blocked } : {}),
    });

    if (item) {
      if (!install.includes(item.slug)) install.push(item.slug);
    } else {
      if (blocked) licensedRoles.push(role.key);
      if (!role.optional) unresolved.push(role.key);
    }
  }

  return {
    recipe: input.recipe,
    kit: input.kit,
    roles,
    install,
    unresolved,
    licensedRoles,
  };
}
