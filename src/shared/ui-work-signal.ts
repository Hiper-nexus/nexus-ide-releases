/**
 * THE vocabulary for "is this UI work?" — one grammar, one canonical form.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four independent grammars used to answer the same question and disagreed in
 * production:
 *
 *   - `VISUAL_CRAFT` / `VISUAL_SURFACE` (src/shared/mission-work-kind.ts)
 *   - `UI_SIGNAL`                       (src/main/context/contract-compiler.ts)
 *   - `UI_MISSION_STRONG` / `UI_MISSION_WEAK` (src/main/orch/guided-squad-skills.ts)
 *
 * The disagreement had a price. `"implementar o CRUD de usuários com paginação"`
 * matched `UI_SIGNAL` (because `pagina` matched INSIDE `paginação` — `ç` is not
 * a `\w`, so `\b` closed right there) and the compiler therefore demanded the
 * `design-system` sensor, while `classifyWorkKind` said `feature` and the
 * bootstrap refused to write any design contract. Result: a required sensor
 * with nothing to check, and a worker with no design clause at all.
 *
 * THE TWO DECISIONS THIS VOCABULARY SERVES
 * ----------------------------------------
 * They have very different costs, so they get different thresholds over the
 * SAME terms — never different word lists:
 *
 *   1. SKILL GRANT (`isUiWorkText`) — grants impeccable/dembrandt. A false
 *      positive costs one unused skill, so the rule is the generous, already
 *      field-calibrated one: ONE self-evident term, or TWO distinct ambiguous
 *      terms (the quorum is what separates "trocar as cores do tema" from
 *      "documentar o esquema de cores do log").
 *   2. DESIGN AUTHORITY (see `decideDesignAuthority` in mission-work-kind) —
 *      requires the `design-system` sensor AND writes a DESIGN.md into the
 *      repository. A false positive here fabricates a design contract inside a
 *      backend repo, so terms carry an `authority` role that is strictly
 *      stricter than `selfEvident`.
 *
 * AUTHORITY ROLES
 * ---------------
 *   craft    — the work ITSELF is visual ("css", "tipografia", "redesign").
 *              Strong on its own.
 *   locative — names a UI place/product ("dashboard", "tela", "modal"). Work of
 *              ANY kind happens there, so it only proves visual work when a
 *              creation/repair verb governs it: "criar a tela" builds UI,
 *              "melhorar a performance do dashboard" does not.
 *   trait    — a visual attribute that also occurs in non-visual prose ("cor",
 *              "tema", "ícone"). Needs a quorum of two.
 *   none     — carries the SKILL signal but must never hang a design contract
 *              on a repository ("aplicativo", "inspirado em X").
 *
 * ASSETS ARE NOT INTERFACES
 * -------------------------
 * `sprite`, `avatar`, `mascote` and friends live in a SEPARATE vocabulary
 * below. A desktop-pet spritesheet is visual work, but it has no static
 * interface for a design contract to govern and no screen for the visual
 * review contract to screenshot — it is nexus-visual-media work. The two
 * predicates are deliberately never fused.
 *
 * Every pattern assumes `canonicalizeWorkText` has already run, so no pattern
 * may contain an accented character and `\b` is always safe.
 */

/** How a term participates in the design-authority decision. */
export type UiAuthorityRole = 'craft' | 'locative' | 'trait' | 'none';

export interface UiWorkTerm {
  /** Stable rule id (`ui.<concept>`), safe to log and to show in the UI. */
  readonly rule: string;
  readonly pattern: RegExp;
  /** True when ONE occurrence already characterizes the mission. */
  readonly selfEvident: boolean;
  readonly authority: UiAuthorityRole;
}

export interface UiWorkMatch {
  readonly rule: string;
  /** Canonicalized text that matched — the "why" a UI can quote. */
  readonly match: string;
  readonly selfEvident: boolean;
  readonly authority: UiAuthorityRole;
}

export interface UiWorkEvidence {
  /** Every distinct term that matched, in declaration order. */
  readonly matches: readonly UiWorkMatch[];
  /** First `craft` match — visual work on its own. */
  readonly craft: UiWorkMatch | null;
  /** First `locative` match — a UI place, strong only under a governing verb. */
  readonly locative: UiWorkMatch | null;
  /** Distinct `trait` matches; two of them form the quorum. */
  readonly traits: readonly UiWorkMatch[];
  /**
   * The SKILL-GRANT verdict: one self-evident term, or two distinct ambiguous
   * ones. This is byte-for-byte the rule `isGuidedUiMissionObjective` was
   * calibrated on against real false positives.
   */
  readonly isUiWork: boolean;
}

/** Distinct ambiguous terms needed to characterize a mission as UI work. */
export const UI_WORK_QUORUM = 2;

/**
 * The one canonical form. NFD, no diacritics, lowercase, collapsed whitespace.
 * Shared so `classifyWorkKind`, the contract compiler and the squad-skill
 * policy can never disagree because one of them forgot to strip an accent —
 * which is exactly how `paginação` became a UI signal.
 */
export function canonicalizeWorkText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `design` alone means visual design in pt-BR (software design is
 * "arquitetura"/"desenho"), but a handful of constructions hand it straight
 * back to the technical domain. The `pattern`/`padrão` arm is the H3 fix:
 * "implementar o design pattern repository no backend" used to fabricate a
 * DESIGN.md in a backend repository.
 */
const DESIGN_NON_VISUAL_TAIL =
  '(?:de\\s+|do\\s+|da\\s+|dos\\s+|das\\s+)?' +
  '(?:api|apis|banco|bancos|dados|schema|schemas|esquema|esquemas|arquitetura|' +
  'sistema|sistemas|infra|classe|classes|tabela|tabelas|contrato|contratos|' +
  'migracao|migracoes|pattern|patterns|padrao|padroes)';

const UI_TERMS: readonly UiWorkTerm[] = Object.freeze([
  // ── craft: the work itself is visual ──────────────────────────────────────
  {
    rule: 'ui.discipline',
    pattern: /\b(?:ui|ux|a11y)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.frontend',
    pattern: /\bfront-?end\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.design-system',
    pattern: /\bdesign[-\s]*system\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.design',
    pattern: new RegExp(`\\bdesign(?!\\s+${DESIGN_NON_VISUAL_TAIL})\\b`),
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.redesign',
    pattern: /\b(?:redesign|redesenh\w*)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.accessibility',
    // "deixe o site acessível para leitor de tela" é trabalho de interface
    // por definição — só "acessibilidade" (o substantivo) casava.
    pattern: /\b(?:acessibilidade|acessive(?:l|is)|accessibility|accessible)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.mockup',
    pattern: /\b(?:mockups?|wireframes?)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.figma',
    pattern: /\bfigma\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    // `visual` only as a NOUN ("o visual do rail", "visual da tela"). As an
    // ADJECTIVE it qualifies non-interface work — "QA visual" of a
    // spritesheet, "regressão visual" — and that mission is an ASSET mission.
    rule: 'ui.visual-noun',
    pattern: /\b(?:o|do|no|ao|um|seu)\s+visual\b|\bvisual\s+(?:do|da|de|dos|das)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.layout',
    pattern: /\blayout\b/,
    selfEvident: true,
    authority: 'craft',
  },
  { rule: 'ui.css', pattern: /\bcss\b/, selfEvident: true, authority: 'craft' },
  {
    rule: 'ui.typography',
    // "padronize as cores e FONTES" tinha um traço só (cores) e ficava fraco.
    pattern: /\b(?:tipografia|typography|fontes?|fonts?)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.spacing',
    pattern: /\bespacamento\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.palette',
    pattern: /\b(?:paleta|palette)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.appearance',
    pattern: /\baparencia\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.responsive',
    pattern: /\b(?:responsiv\w*|responsive)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.styling',
    pattern: /\b(?:estiliz\w*|styling)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.dark-mode',
    pattern: /\b(?:dark\s*mode|modo\s+escuro)\b/,
    selfEvident: true,
    authority: 'craft',
  },
  {
    rule: 'ui.contrast',
    pattern: /\bcontrast(?:e|o)?\b/,
    selfEvident: true,
    authority: 'craft',
  },

  // ── locative: a UI product/place. Self-evident for the skill grant, but it
  //    needs a governing verb before it may hang a design contract.
  {
    rule: 'ui.interface',
    pattern: /\binterface\b/,
    selfEvident: true,
    authority: 'locative',
  },
  {
    rule: 'ui.dashboard',
    pattern: /\b(?:dashboard|painel)\b/,
    selfEvident: true,
    authority: 'locative',
  },
  {
    rule: 'ui.landing',
    pattern: /\blanding(?:\s*page)?\b/,
    selfEvident: true,
    authority: 'locative',
  },
  {
    rule: 'ui.website',
    pattern: /\b(?:website|web\s*app|brand\s+site)\b/,
    selfEvident: true,
    authority: 'locative',
  },
  {
    // Ambiguous nouns: locative for authority, quorum-bound for the skill
    // grant. "corrigir o bug da tela de erro que trava o backend" must not
    // read as UI work, and one screen noun is exactly what that goal has.
    rule: 'ui.screen',
    pattern: /\b(?:telas?|screens?)\b/,
    selfEvident: false,
    authority: 'locative',
  },
  {
    // NOTE: matched against the CANONICAL text, so `paginacao` cannot match
    // here — the `\b` after `pagina` fails against `c`. That is C2's fix.
    rule: 'ui.page',
    pattern: /\b(?:paginas?|pages?)\b/,
    selfEvident: false,
    authority: 'locative',
  },
  {
    rule: 'ui.button',
    pattern: /\b(?:bot(?:ao|oes)|buttons?)\b/,
    selfEvident: false,
    authority: 'locative',
  },
  {
    // Lugares que o leigo nomeia o tempo todo e não estavam aqui: o
    // formulário de contato, o rodapé, o cabeçalho.
    rule: 'ui.form',
    pattern: /\b(?:formularios?|forms?)\b/,
    selfEvident: false,
    authority: 'locative',
  },
  {
    rule: 'ui.chrome',
    pattern: /\b(?:rodape|footers?|cabecalhos?|headers?)\b/,
    selfEvident: false,
    authority: 'locative',
  },
  {
    rule: 'ui.widget',
    pattern: /\b(?:modal|modais|menus?|sidebars?)\b/,
    selfEvident: false,
    authority: 'locative',
  },

  // ── trait: a visual attribute that also shows up in non-visual prose ──────
  {
    // H3: `cores?` matched `core`/`cores` but NOT `cor`, so "trocar a cor
    // primária" produced no signal while "refatorar o core do serviço" fired
    // `visual.craft`. `cor(?:es)?` is the shape the product already had right
    // in the guided squad policy.
    rule: 'ui.color',
    pattern: /\b(?:cor(?:es)?|colors?)\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.theme',
    pattern: /\b(?:temas?|themes?)\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.style',
    pattern: /\b(?:estilos?|styles?)\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.icon',
    pattern: /\b(?:icones?|icons?)\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.alignment',
    pattern: /\balinha\w*\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.beauty',
    pattern: /\bbonit\w*\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.ugly',
    pattern: /\bfei[oa]s?\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.modern',
    pattern: /\bmodern[oa]s?\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.dark',
    pattern: /\bescur[oa]s?\b/,
    selfEvident: false,
    authority: 'trait',
  },
  {
    rule: 'ui.animation',
    pattern: /\b(?:animacao|animacoes|animations?)\b/,
    selfEvident: false,
    authority: 'trait',
  },

  // ── skill-only: real UI evidence that must never author a design contract ─
  {
    // Too generic to hang a contract on: "aplicativo de cobrança" is not
    // visual work, but a roster working on "o aplicativo" still benefits from
    // impeccable.
    rule: 'ui.app',
    pattern: /\baplicativo\b/,
    selfEvident: true,
    authority: 'none',
  },
  {
    // "inspirado em stripe.com" is a DIRECTION, not a claim that this mission
    // builds UI — "implementar cache inspirado no redis" is backend work.
    rule: 'ui.reference',
    pattern: /\b(?:inspirad\w*|parecido\s+com)\b/,
    selfEvident: true,
    authority: 'none',
  },
]);

function matchTerms(
  canonical: string,
  terms: readonly UiWorkTerm[],
): UiWorkMatch[] {
  const matches: UiWorkMatch[] = [];
  for (const term of terms) {
    const found = term.pattern.exec(canonical);
    if (!found) continue;
    matches.push(
      Object.freeze({
        rule: term.rule,
        match: found[0],
        selfEvident: term.selfEvident,
        authority: term.authority,
      }),
    );
  }
  return matches;
}

const EMPTY_MATCHES: readonly UiWorkMatch[] = Object.freeze([]);

/**
 * Collect every UI term present, with the tier information both decisions
 * need. Pure and deterministic; the same text always yields the same bytes.
 */
export function collectUiWorkEvidence(value: string): UiWorkEvidence {
  const canonical = canonicalizeWorkText(value);
  if (canonical === '') {
    return Object.freeze({
      matches: EMPTY_MATCHES,
      craft: null,
      locative: null,
      traits: EMPTY_MATCHES,
      isUiWork: false,
    });
  }
  const matches = matchTerms(canonical, UI_TERMS);
  const craft = matches.find((m) => m.authority === 'craft') ?? null;
  const locative = matches.find((m) => m.authority === 'locative') ?? null;
  const traits = matches.filter((m) => m.authority === 'trait');
  const selfEvident = matches.some((m) => m.selfEvident);
  const ambiguousCount = matches.filter((m) => !m.selfEvident).length;
  return Object.freeze({
    matches: Object.freeze(matches),
    craft,
    locative,
    traits: Object.freeze(traits),
    isUiWork: selfEvident || ambiguousCount >= UI_WORK_QUORUM,
  });
}

/**
 * The SKILL-GRANT predicate: does this mission touch UI at all?
 *
 * Generous by design (one self-evident term, or a quorum of two ambiguous
 * ones) because the cost of a false positive is a single unused skill. Never
 * use this to decide whether to WRITE a design contract — use
 * `decideDesignAuthority` for that.
 */
export function isUiWorkText(value: string): boolean {
  return collectUiWorkEvidence(value).isUiWork;
}

// ---------------------------------------------------------------------------
// Visual ASSETS — a different concept, deliberately not fused with UI work.
// ---------------------------------------------------------------------------

export interface VisualAssetTerm {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly selfEvident: boolean;
}

export interface VisualAssetEvidence {
  readonly matches: readonly UiWorkMatch[];
  readonly isVisualAsset: boolean;
}

const ASSET_TERMS: readonly VisualAssetTerm[] = Object.freeze([
  {
    rule: 'asset.sprite',
    pattern: /\b(?:sprite(?:\s*sheets?)?|spritesheets?)\b/,
    selfEvident: true,
  },
  { rule: 'asset.avatar', pattern: /\bavatar(?:es|s)?\b/, selfEvident: true },
  {
    rule: 'asset.mascot',
    pattern: /\b(?:mascotes?|mascots?)\b/,
    selfEvident: true,
  },
  {
    rule: 'asset.illustration',
    pattern: /\b(?:ilustracao|ilustracoes|illustrations?|artworks?)\b/,
    selfEvident: true,
  },
  { rule: 'asset.desktop-pet', pattern: /\bdesktop\s*pet\b/, selfEvident: true },
  {
    rule: 'asset.declared',
    pattern: /\b(?:assets?\s+visua(?:l|is)|visual\s+assets?)\b/,
    selfEvident: true,
  },
  // Generic media nouns need company. `imagens` alone used to make
  // "implementar cache no serviço de imagens" a visual mission.
  {
    rule: 'asset.image',
    pattern: /\b(?:imagens?|images?)\b/,
    selfEvident: false,
  },
  { rule: 'asset.photo', pattern: /\b(?:fotos?|photos?)\b/, selfEvident: false },
  { rule: 'asset.art', pattern: /\bartes?\b/, selfEvident: false },
  { rule: 'asset.logo', pattern: /\blogos?\b/, selfEvident: false },
  { rule: 'asset.icon', pattern: /\b(?:icones?|icons?)\b/, selfEvident: false },
]);

/**
 * Collect visual-ASSET evidence (sprite/avatar/mascote/illustration). Same
 * two-tier discipline as the UI grammar: one unambiguous asset noun fires
 * alone, generic media nouns need a quorum of two.
 */
export function collectVisualAssetEvidence(value: string): VisualAssetEvidence {
  const canonical = canonicalizeWorkText(value);
  if (canonical === '') {
    return Object.freeze({ matches: EMPTY_MATCHES, isVisualAsset: false });
  }
  const matches = matchTerms(
    canonical,
    ASSET_TERMS.map((term) => ({
      rule: term.rule,
      pattern: term.pattern,
      selfEvident: term.selfEvident,
      authority: 'none' as const,
    })),
  );
  const selfEvident = matches.some((m) => m.selfEvident);
  const genericCount = matches.filter((m) => !m.selfEvident).length;
  return Object.freeze({
    matches: Object.freeze(matches),
    isVisualAsset: selfEvident || genericCount >= UI_WORK_QUORUM,
  });
}

/** True when the mission produces visual ASSETS (not an interface). */
export function isVisualAssetText(value: string): boolean {
  return collectVisualAssetEvidence(value).isVisualAsset;
}
