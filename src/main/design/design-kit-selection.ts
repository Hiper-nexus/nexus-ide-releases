import type { DesignKitSummary } from './design-kit-source';

/**
 * WHO OWNS "WHICH KIT" — the deterministic direction rule.
 *
 * Before this module nothing decided which design reference a project should
 * follow, so the only honest move was to decide nothing. The dangerous fix
 * would have been "pick the closest famous brand": importing `stripe` into a
 * project that is not a fintech is worse than having no contract at all — it
 * hands the mission a confident, wrong identity that every later task then
 * defends.
 *
 * So the rule below is deliberately CONSERVATIVE and, in the ambiguous case,
 * deliberately USELESS. Three steps, in order:
 *
 *   1. `setting` — the operator pinned `orch.designDefaultKit`. A human said
 *      it; nothing else may outrank it. If the pinned kit is not in the
 *      catalog, the answer is NEUTRAL — never "the nearest other brand",
 *      which would silently swap the brand a human chose.
 *   2. `match`   — the goal and exactly one kit share domain axes (fintech,
 *      dashboard, devtool, marketing, docs, commerce). A win must be STRICT:
 *      any tie, and any goal that fires no axis at all, falls through.
 *   3. `neutral` — the house baseline. Not a failure mode: it is the correct
 *      answer whenever the evidence does not name a direction.
 *
 * Matching runs over the SAME axis vocabulary on both sides — the goal's words
 * and the kit's own metadata (title, description, tags, id). That is what
 * makes a match auditable: the document can name the axes that fired, and a
 * reader can check them against the kit file. Generic UI words ("design",
 * "layout", "button", "page") are deliberately absent from every axis, because
 * they fire for every kit and would turn matching into a coin flip wearing a
 * brand name.
 *
 * Pure: no I/O, no clock, no randomness. The caller supplies the catalog.
 */

export const DESIGN_DOMAIN_AXES = [
  'fintech',
  'dashboard',
  'devtool',
  'marketing',
  'docs',
  'commerce',
] as const;

export type DesignDomainAxis = (typeof DESIGN_DOMAIN_AXES)[number];

/**
 * Axis vocabulary (pt-BR + en), matched against the accent-stripped canonical
 * form. Every token here must name a PRODUCT DOMAIN, never a UI primitive: a
 * token that appears in the metadata of most kits is noise that manufactures
 * false matches.
 */
const AXIS_PATTERNS: Readonly<Record<DesignDomainAxis, RegExp>> = Object.freeze({
  // `bancos? (?!de dados)`: a bare "banco" in pt-BR is far more often the
  // start of "banco de dados" (a database) than a bank. Without the lookahead
  // this axis fired for every database project and handed it a payments
  // brand — the exact accident this module exists to prevent.
  fintech:
    /\b(fintech|financ(?:e|ial|eir[oa]s?)|payments?|pagamentos?|checkout|billing|cobranca|invoices?|faturas?|bank(?:ing|s)?|banc(?:aria|arias|ario|arios)|bancos?(?!\s+de\s+dados)|wallets?|carteiras?|pix|money|remittance|tesouraria|treasury)\b/,
  dashboard:
    /\b(dashboards?|admin|analytics?|analitico|metricas?|metrics?|kpis?|graficos?|charts?|relatorios?|reports?|telemetria|telemetry|bi\b|dense)\b/,
  // No `infra`/`devops` here on purpose: "financial-infrastructure" is a
  // fintech phrase, and letting `infra` vote for dev tooling made a payments
  // kit tie with a database kit on a database goal.
  devtool:
    /\b(developers?|desenvolvedor(?:es)?|dev\s*tools?|ferramentas?\s+de\s+dev|sdks?|clis?|terminals?|ide\b|database|banco\s+de\s+dados|schemas?|queries|open-?source|technical|tecnic[oa]s?|engineering|engenharia)\b/,
  marketing:
    /\b(marketing|landing(?:\s*pages?)?|campanhas?|campaigns?|institucional|lancamento|launch|pricing|precos?|vitrine|showcase|brand(?:ing)?|advertis(?:e|ing))\b/,
  docs: /\b(docs?|documentacao|documentation|wiki|knowledge|conhecimento|notas?|notes?|blogs?|artigos?|articles?|conteudo|content|editor(?:es|ial)?|workspace|handbook)\b/,
  commerce:
    /\b(ecommerce|e-commerce|lojas?|stores?|storefront|carrinho|carts?|catalogos?|catalogs?|produtos?\s+a\s+venda|marketplaces?|assinaturas?|subscriptions?)\b/,
});

/** Same canonical form as `classifyWorkKind`: NFD, no accents, lowercase. */
function canonical(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bounded: kit metadata is third-party text and must not become a scan bomb. */
const MAX_SCANNED_CHARS = 8 * 1024;

function axesIn(text: string): readonly DesignDomainAxis[] {
  const haystack = canonical(text).slice(0, MAX_SCANNED_CHARS);
  return Object.freeze(
    DESIGN_DOMAIN_AXES.filter((axis) => AXIS_PATTERNS[axis].test(haystack)),
  );
}

/** Everything a kit says about itself, as one scannable corpus. */
export function designKitCorpus(kit: DesignKitSummary): string {
  return [kit.kitId, kit.title, kit.description, ...kit.tags].join('\n');
}

export interface DesignKitAxisScore {
  readonly kitId: string;
  /** Axes present in BOTH the goal and this kit's metadata. */
  readonly sharedAxes: readonly DesignDomainAxis[];
  readonly score: number;
}

export type DesignDirectionNeutralReason =
  /** No kit is reachable at all (catalog missing/empty). */
  | 'empty-catalog'
  /** `orch.designDefaultKit` names a kit this catalog does not have. */
  | 'pinned-kit-unavailable'
  /** The goal fires no product-domain axis that any kit also claims. */
  | 'no-domain-signal'
  /** Two or more kits tie, so no direction is proven. */
  | 'ambiguous-match';

export type DesignDirectionChoice =
  | {
      readonly mode: 'setting';
      readonly kit: DesignKitSummary;
      /** Axes the goal fires, recorded for the document even when unused. */
      readonly goalAxes: readonly DesignDomainAxis[];
    }
  | {
      readonly mode: 'match';
      readonly kit: DesignKitSummary;
      readonly goalAxes: readonly DesignDomainAxis[];
      readonly sharedAxes: readonly DesignDomainAxis[];
      readonly confidence: 'high' | 'low';
      readonly runnerUpScore: number;
    }
  | {
      readonly mode: 'neutral';
      readonly reason: DesignDirectionNeutralReason;
      readonly goalAxes: readonly DesignDomainAxis[];
    };

export interface SelectDesignDirectionInput {
  readonly goal: string;
  /** `orch.designDefaultKit`; empty/absent means "no pin". */
  readonly pinnedKitId?: string | null;
  readonly kits: readonly DesignKitSummary[];
}

/**
 * A single shared axis is a real (if thin) signal — only ONE kit in a catalog
 * usually talks about payments. Two or more is a direction.
 */
const HIGH_CONFIDENCE_SHARED_AXES = 2;

export function scoreDesignKitsAgainstGoal(
  goal: string,
  kits: readonly DesignKitSummary[],
): readonly DesignKitAxisScore[] {
  const goalAxes = axesIn(goal);
  return Object.freeze(
    kits.map((kit) => {
      const kitAxes = new Set(axesIn(designKitCorpus(kit)));
      const sharedAxes = goalAxes.filter((axis) => kitAxes.has(axis));
      return Object.freeze({
        kitId: kit.kitId,
        sharedAxes: Object.freeze(sharedAxes),
        score: sharedAxes.length,
      });
    }),
  );
}

/**
 * The whole rule, in one deterministic function. Same inputs always produce
 * the same frozen choice, which is what lets an independent reviewer
 * re-derive the resulting contract byte for byte.
 */
export function selectDesignDirection(
  input: SelectDesignDirectionInput,
): DesignDirectionChoice {
  const goalAxes = axesIn(input.goal);
  const pinnedKitId = (input.pinnedKitId ?? '').trim();

  if (pinnedKitId !== '') {
    const pinned = input.kits.find((kit) => kit.kitId === pinnedKitId);
    // A pin that cannot be honored falls to NEUTRAL, never to a near miss:
    // substituting another brand for the one a human chose is the exact
    // failure this module exists to prevent.
    return pinned
      ? Object.freeze({ mode: 'setting' as const, kit: pinned, goalAxes })
      : Object.freeze({
          mode: 'neutral' as const,
          reason: 'pinned-kit-unavailable' as const,
          goalAxes,
        });
  }

  if (input.kits.length === 0) {
    return Object.freeze({
      mode: 'neutral' as const,
      reason: 'empty-catalog' as const,
      goalAxes,
    });
  }
  if (goalAxes.length === 0) {
    return Object.freeze({
      mode: 'neutral' as const,
      reason: 'no-domain-signal' as const,
      goalAxes,
    });
  }

  const scored = [...scoreDesignKitsAgainstGoal(input.goal, input.kits)].sort(
    (left, right) =>
      right.score - left.score || left.kitId.localeCompare(right.kitId),
  );
  const best = scored[0];
  const runnerUpScore = scored[1]?.score ?? 0;
  if (!best || best.score === 0 || best.score === runnerUpScore) {
    return Object.freeze({
      mode: 'neutral' as const,
      reason:
        best && best.score > 0
          ? ('ambiguous-match' as const)
          : ('no-domain-signal' as const),
      goalAxes,
    });
  }

  const kit = input.kits.find((candidate) => candidate.kitId === best.kitId)!;
  return Object.freeze({
    mode: 'match' as const,
    kit,
    goalAxes,
    sharedAxes: best.sharedAxes,
    confidence:
      best.score >= HIGH_CONFIDENCE_SHARED_AXES
        ? ('high' as const)
        : ('low' as const),
    runnerUpScore,
  });
}
