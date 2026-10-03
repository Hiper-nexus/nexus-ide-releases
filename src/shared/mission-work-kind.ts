/**
 * Mission work-kind classifier — pure domain, zero I/O.
 *
 * WHY THIS EXISTS
 * ---------------
 * Today Nexus does not classify the TYPE of work a goal asks for. The proof is
 * in `suggestMissionLaneFromGoal` (src/shared/mission-intent.ts): its `implement`
 * regex holds `corrigir|bug` AND `feature` in the SAME alternation and returns
 * `null` for both. So "corrigir um bug" and "criar uma feature" take a byte-for-
 * byte identical path: same lane, same squad, same skills, same graph shape,
 * same delivery contract. Only "visual/UI" work is actually differentiated
 * anywhere (guided-squad-skills grants impeccable/dembrandt, contract-compiler
 * requires the design-system sensor). Bug, feature and doc get nothing.
 *
 * This module is the missing discriminator. It classifies the goal ONCE, purely,
 * and hands the caller a kind plus the evidence for it. It deliberately does not
 * decide squads, skills or graphs — that wiring is the consumer's job. Keeping
 * the decision here means bug and feature can stop being the same path without
 * every call site growing its own regex.
 *
 * VOCABULARY PROVENANCE (do not fork the product's words)
 * -------------------------------------------------------
 * The VISUAL vocabulary is no longer declared here at all: it is imported from
 * `./ui-work-signal`, which is the single source of truth shared with the
 * contract compiler, the design-contract bootstrap and the guided squad-skill
 * policy. Four grammars used to answer "is this UI?" and they disagreed in
 * production — see that module's header for the incident.
 *
 * The remaining token lists (doc, bug, ops, feature) are derived from
 * heuristics that already ship:
 *   - ops regex, implement regex      — suggestMissionLaneFromGoal (mission-intent.ts)
 *   - MUTATING_ACTION / PRODUCT_SURFACE_MUTATION / canonicalGoal — mission-topology.ts
 * They are re-declared (not imported) because `src/shared` must not import from
 * `src/main`. Deliberate deviations from the source lists are marked
 * "DEVIATION" inline.
 *
 * HONESTY CONTRACT
 * ----------------
 * `unknown` is a first-class, expected answer. The consumer treats it as "use
 * the current generic path", so a wrong guess is strictly worse than admitting
 * ignorance. Every verdict also carries `confidence` and the `signals` that
 * fired, so the caller can gate on evidence and the UI can explain the choice
 * to the user instead of asserting it.
 */

import {
  canonicalizeWorkText,
  collectUiWorkEvidence,
  collectVisualAssetEvidence,
  isUiWorkText,
  UI_WORK_QUORUM,
} from './ui-work-signal';

export const WORK_KINDS = [
  'bug',
  'feature',
  'doc',
  'visual',
  'ops',
  'unknown',
] as const;

/** Discriminant for the classifier verdict. */
export type WorkKind = (typeof WORK_KINDS)[number];

export type WorkKindConfidence = 'high' | 'low';

/** Strength tier of a single matched signal. `weak` can never outrank `strong`. */
export type WorkKindSignalStrength = 'strong' | 'weak';

export interface WorkKindSignal {
  /** Kind this signal votes for. */
  readonly kind: Exclude<WorkKind, 'unknown'>;
  /** Stable rule id (`<kind>.<rule>`), safe to show in the UI and to log. */
  readonly rule: string;
  readonly strength: WorkKindSignalStrength;
  /** Canonicalized text that matched — the "why" the UI can quote. */
  readonly match: string;
}

export interface WorkKindVerdict {
  readonly kind: WorkKind;
  readonly confidence: WorkKindConfidence;
  /** Every signal seen, winners and losers, in detection order. */
  readonly signals: readonly WorkKindSignal[];
  /** Short pt-BR explanation of the decision, for the UI and mission logs. */
  readonly reason: string;
}

/**
 * PRECEDENCE — highest first. Applied within a strength tier: all `strong`
 * signals are considered first, and only if none exist do `weak` signals decide
 * (always with `confidence: 'low'`).
 *
 *   1. bug    — an explicit defect + repair claim is the deliverable ("corrigir
 *               o bug do login e atualizar o CHANGELOG" ships a fix; the doc is
 *               a byproduct). A goal that merely MENTIONS a defect without a
 *               repair verb never produces a strong bug signal, which is what
 *               keeps "documentar os bugs conhecidos" on doc.
 *   2. doc    — the deliverable is a document, not code ("escrever o PRD da
 *               feature X" is doc work even though it names a feature).
 *   3. visual — the surface is UI/visual. This is the one kind the product
 *               already differentiates, so it outranks generic build work.
 *   4. ops    — infrastructure/release surface.
 *   5. feature— new capability. Lowest because every other kind is a more
 *               specific claim about the same "build something" intent.
 *
 * Special rule: a strong visual signal SUPPRESSES `feature.create`, because
 * "criar a nova tela" is one claim (build UI), not two competing ones. Doc does
 * NOT suppress it, because "criar a feature e escrever o PRD" really is two
 * deliverables — that goal stays mixed and lands on `confidence: 'low'`.
 */
export const WORK_KIND_PRECEDENCE = [
  'bug',
  'doc',
  'visual',
  'ops',
  'feature',
] as const;

/**
 * Shortest goal worth classifying. Mirrors the guards in
 * `suggestMissionLaneFromGoal` and `classifyStandardMissionTopology`.
 */
export const MIN_CLASSIFIABLE_GOAL_CHARS = 8;

/**
 * Same canonical form used by mission-topology: NFD, no accents, lowercase.
 * Imported, not re-declared: a goal that is canonicalized in one place and not
 * in another is precisely how `paginação` became a UI signal.
 */
const canonicalGoal = canonicalizeWorkText;

// ---------------------------------------------------------------------------
// Vocabulary. All patterns assume the canonical (accent-stripped) form.
// ---------------------------------------------------------------------------

/** Document artifacts. DEVIATION: no bare `spec` (collides with *.spec.ts) and
 *  no bare `manual` (adjective in pt-BR: "teste manual"). */
const DOC_ARTIFACT =
  /\b(prd|adr|rfc|readme|changelog|release\s+notes|runbook|playbook|documentacao|documentation|docs?|guia|guide|tutorial|especificacao|specification|handbook|wiki|postmortem|post\s*mortem|relatorio)\b/;

const DOC_VERB =
  /\b(documentar|documente|documenta|documentando|document|documenting|redigir|redija)\b/;

/** Defect nouns/states. Presence alone is only a weak signal (see precedence). */
const DEFECT =
  /\b(bugs?|erros?|errors?|falhas?|failing|failures?|crash(?:es|ed|ing)?|quebrad[oa]s?|broken|regress(?:ao|oes|ion)|excecao|exception|stack\s*trace|traceback|nao\s+(?:funciona|responde|abre)|not\s+working|unresponsive|flaky|memory\s+leak|vazamento\s+de\s+memoria|leak|deadlock|trav(?:a|am|ando|ou|ar)|hang(?:s|ing)?|freez(?:e|es|ing)|panic|500)\b/;

/**
 * Repair orders. DEVIATION: the gerund/noun forms `troubleshooting` and
 * `debugging` are excluded on purpose — they name a document topic far more
 * often than a repair order ("guia de troubleshooting dos erros"), and letting
 * them through made bug outrank doc on exactly that phrasing.
 */
const REPAIR_VERB =
  /\b(corrig(?:ir|e|em|indo)|corrija|correcao|arrum(?:ar|e|a)|consert(?:ar|e|a)|resolv(?:er|a|e)|debug(?:ar)?|depurar|fix(?:es|ed|ing)?|repair|hotfix|troubleshoot)\b/;

/**
 * F-772: escopo de AUDITORIA/INVENTÁRIO — "auditoria de uso", "inventário de
 * configuração", "mapear os providers". Um defeito NOMEADO dentro de um
 * escopo assim enumera achados esperados, não um mau funcionamento relatado:
 * bug exige defeito que o chamador quer CONSERTADO, então a menção fraca é
 * suprimida (defeito + verbo de reparo — "audite e corrija" — continua bug
 * forte). `audit log`/`audit trail` nomeiam artefatos, não tarefa de
 * auditoria — por isso o lookahead.
 */
const AUDIT_SCOPE =
  /\b(?:(?:auditorias?|auditar|audites?|audita|audit(?:s|ed|ing)?)(?!\s+(?:logs?|trails?))|inventarios?|inventariar|inventor(?:y|ies)|censos?|census|levantamentos?|mapeamentos?|mapear|mapeie)\b/;

/*
 * VISUAL vocabulary — NOT declared here. `./ui-work-signal` owns it, and this
 * module reads its tiers:
 *   craft    → `visual.craft`  strong on its own
 *   trait    → `visual.quorum` strong at two distinct traits, else
 *              `visual.trait` weak
 *   locative → `visual.surface` strong only under a creation/repair verb,
 *              because "melhorar a performance do dashboard" is not visual work
 *   asset    → `visual.asset` strong (sprite/avatar/mascote); a DIFFERENT
 *              concept from UI, see `decideDesignAuthority`
 */

/**
 * Infrastructure/release surface. Derived from the ops branch of
 * `suggestMissionLaneFromGoal`.
 * DEVIATION: `producao`/`staging` dropped (they name a place, not a work type —
 * "corrigir o bug em producao" is a bug); `migrar` dropped (ambiguous: db, code
 * or infra); `pausar` dropped (too generic); bare `pipeline` dropped (a data
 * pipeline is not ops work) — it only counts next to a CI/CD/release word.
 */
const OPS_SURFACE =
  /\b(deploy(?:ar|ment)?s?|backups?|ssh|vps|servidor(?:es)?|servers?|dns|dominio|domain|certificad[oa]s?|ssl|tls|infra|infraestrutura|infrastructure|docker|kubernetes|k8s|terraform|ansible|nginx|ci\/cd|ci|github\s+actions|pipelines?\s+(?:de\s+|do\s+|of\s+)?(?:ci|cd|build|deploy|release|entrega)|(?:ci|cd|build|deploy|release)\s+pipelines?|rollback|restart(?:ar)?|reiniciar|publicar|publique|publish|releases?|notariz\w*|cron|systemd|monitoramento|monitoring|observabilidade|observability|subir)\b/;

/**
 * New-capability verbs. Mirrors the implement branch of the lane heuristic and
 * the creation verbs of PRODUCT_SURFACE_MUTATION (`fac|cri|constru|desenvolv|
 * make|create|build|develop`). `make` carries a lookahead so the English filler
 * "make sure ..." never reads as a creation order.
 */
/**
 * Verbos de RETRABALHO — o que o leigo mais usa quando já existe uma tela.
 *
 * "refaça a tela de cadastro pra ficar bonita no celular" não casava em
 * CREATION_VERB nem em REPAIR_VERB (sonda 23/08), então `visual.surface`
 * ficava FRACO e a missão de UI mais óbvia do mundo saía com confiança baixa
 * — sem autoridade de design, ou seja, sem DESIGN.md.
 *
 * Fica SEPARADO de CREATION_VERB de propósito: aqui ele só decide se um
 * substantivo de superfície é governado por um verbo.
 *
 * Deliberadamente ESTREITO: só verbos que significam refazer A COISA. Incluir
 * "melhorar"/"ajustar" quebraria o invariante correto da casa — "melhorar a
 * performance do dashboard" é trabalho de performance, não de design, e o
 * substantivo ali é apenas locativo.
 */
const REWORK_VERB =
  /\b(refaz(?:er|e)|refac[ao]|redesenh(?:ar|e|a)|remodel(?:ar|e|a)|reformul(?:ar|e|a)|redo|rework|redesign)\b/;

const CREATION_VERB =
  /\b(implement(?:ar|e|a|acao|ing|ed)?|criar|crie|cria|construir|construa|mont(?:ar|e|a)|desenvolv(?:er|a)|adicion(?:ar|e|a)|ger(?:ar|e|a)|faz(?:er|a)|faca|nov[ao]s?|suporte\s+a|habilitar|introduzir|create|build|develop|generate|make(?!\s+sure)|add|new|support\s+for|enable|introduce)\b/;

/** Bare mention of a feature; never decides on its own at strong tier. */
const FEATURE_NOUN = /\b(features?|funcionalidades?)\b/;

interface RuleSpec {
  readonly kind: Exclude<WorkKind, 'unknown'>;
  readonly rule: string;
  readonly pattern: RegExp;
}

function matchSignal(
  canonical: string,
  spec: RuleSpec,
  strength: WorkKindSignalStrength,
): WorkKindSignal | null {
  const found = spec.pattern.exec(canonical);
  if (!found) return null;
  return Object.freeze({
    kind: spec.kind,
    rule: spec.rule,
    strength,
    match: found[0],
  });
}

/**
 * Collects every signal present in the goal. Order is stable (doc, bug, visual,
 * ops, feature) so verdicts are reproducible and diffable.
 */
function collectSignals(canonical: string): WorkKindSignal[] {
  const signals: WorkKindSignal[] = [];
  const push = (signal: WorkKindSignal | null): void => {
    if (signal) signals.push(signal);
  };

  push(
    matchSignal(
      canonical,
      { kind: 'doc', rule: 'doc.artifact', pattern: DOC_ARTIFACT },
      'strong',
    ),
  );
  push(
    matchSignal(
      canonical,
      { kind: 'doc', rule: 'doc.verb', pattern: DOC_VERB },
      'strong',
    ),
  );

  const defect = DEFECT.exec(canonical);
  const repair = REPAIR_VERB.exec(canonical);
  const auditScope = AUDIT_SCOPE.test(canonical);
  if (defect && (repair || !auditScope)) {
    // A defect noun WITH a repair verb is a repair order (strong). Alone it is
    // only a mention — this is what keeps "documentar os bugs conhecidos" on doc.
    // F-772: inside an audit/inventory scope the mention enumerates expected
    // findings ("auditoria de uso apontando erros") — not a reported
    // malfunction — so it is suppressed entirely and the task stays general.
    push(
      Object.freeze({
        kind: 'bug',
        rule: repair ? 'bug.defect' : 'bug.defect-mention',
        strength: repair ? 'strong' : 'weak',
        match: repair ? `${repair[0]} ${defect[0]}` : defect[0],
      }),
    );
  } else if (repair && !defect) {
    // Repair verb with no named defect: corrective in nature, but the surface
    // may still claim it (e.g. "arrumar o visual do rail" is visual work).
    push(
      Object.freeze({
        kind: 'bug',
        rule: 'bug.repair',
        strength: 'weak',
        match: repair[0],
      }),
    );
  }

  const ui = collectUiWorkEvidence(canonical);
  const creation = CREATION_VERB.exec(canonical);
  const rework = REWORK_VERB.exec(canonical);
  const governingVerb = creation !== null || repair !== null || rework !== null;

  const visual = (
    rule: string,
    strength: WorkKindSignalStrength,
    match: string,
  ): WorkKindSignal =>
    Object.freeze({ kind: 'visual' as const, rule, strength, match });

  if (ui.craft) push(visual('visual.craft', 'strong', ui.craft.match));

  // Two distinct visual TRAITS characterize the mission ("trocar as cores do
  // tema"); a single one does not ("implementar o tema do relatório mensal").
  if (ui.traits.length >= UI_WORK_QUORUM) {
    push(
      visual(
        'visual.quorum',
        'strong',
        ui.traits.map((trait) => trait.match).join(' + '),
      ),
    );
  } else if (ui.traits.length === 1) {
    // Um traço SOZINHO é fraco ("implementar o tema do relatório mensal").
    // Mas traço + superfície visual são DOIS sinais visuais distintos
    // caracterizando a missão — o mesmo raciocínio do quórum de dois traços.
    // Sem isto, "deixa a tela inicial mais bonita" (o jeito mais comum de
    // quem não é dev pedir trabalho de UI) saía com confiança baixa e sem
    // DESIGN.md. A superfície sozinha continua locativa: "a performance do
    // dashboard" não tem traço e segue fraca.
    if (ui.locative) {
      push(
        visual(
          'visual.quorum',
          'strong',
          `${ui.traits[0].match} + ${ui.locative.match}`,
        ),
      );
    } else {
      push(visual('visual.trait', 'weak', ui.traits[0].match));
    }
  }

  // A surface noun only proves visual WORK when a creation or repair verb acts
  // on it. Without a verb it is locative ("a performance do dashboard").
  if (ui.locative) {
    push(
      visual(
        'visual.surface',
        governingVerb ? 'strong' : 'weak',
        ui.locative.match,
      ),
    );
  }

  // Visual ASSETS (sprite/avatar/mascote) are visual work — strong enough to
  // win the precedence — but they are NOT an interface: `decideDesignAuthority`
  // refuses design authority to an asset-only mission (`asset-not-interface`).
  const asset = collectVisualAssetEvidence(canonical);
  const assetMatch = asset.isVisualAsset ? asset.matches[0] : undefined;
  if (assetMatch) push(visual('visual.asset', 'strong', assetMatch.match));

  const strongVisual = signals.some(
    (signal) => signal.kind === 'visual' && signal.strength === 'strong',
  );

  push(
    matchSignal(
      canonical,
      { kind: 'ops', rule: 'ops.surface', pattern: OPS_SURFACE },
      'strong',
    ),
  );

  // A creation verb over a UI surface is ONE claim (build UI), not a competing
  // feature claim — this is what keeps "criar a nova tela" at high confidence.
  if (!strongVisual) {
    push(
      matchSignal(
        canonical,
        { kind: 'feature', rule: 'feature.create', pattern: CREATION_VERB },
        'strong',
      ),
    );
  }
  push(
    matchSignal(
      canonical,
      { kind: 'feature', rule: 'feature.mention', pattern: FEATURE_NOUN },
      'weak',
    ),
  );

  return signals;
}

function firstByPrecedence(
  signals: readonly WorkKindSignal[],
): Exclude<WorkKind, 'unknown'> | null {
  return (
    WORK_KIND_PRECEDENCE.find((kind) =>
      signals.some((signal) => signal.kind === kind),
    ) ?? null
  );
}

const PRECEDENCE_LABEL = WORK_KIND_PRECEDENCE.join(' > ');

function buildReason(input: {
  readonly kind: Exclude<WorkKind, 'unknown'>;
  readonly tier: WorkKindSignalStrength;
  readonly competingKinds: readonly string[];
  readonly winningMatch: string;
}): string {
  const { kind, tier, competingKinds, winningMatch } = input;
  if (tier === 'weak') {
    return `Somente sinais fracos (${kind}: "${winningMatch}"). Confianca baixa — trate como pista, nao como decisao.`;
  }
  if (competingKinds.length > 0) {
    return `${kind} vence ${competingKinds.join(', ')} pela precedencia ${PRECEDENCE_LABEL} (sinal forte em ambos: "${winningMatch}").`;
  }
  return `Sinal forte de ${kind} ("${winningMatch}") sem nenhum outro tipo competindo.`;
}

function verdict(
  kind: WorkKind,
  confidence: WorkKindConfidence,
  signals: readonly WorkKindSignal[],
  reason: string,
): WorkKindVerdict {
  return Object.freeze({
    kind,
    confidence,
    signals: Object.freeze([...signals]),
    reason,
  });
}

const NO_SIGNALS: readonly WorkKindSignal[] = Object.freeze([]);

/**
 * Visual rules whose evidence is an INTERFACE (a screen a human operates), as
 * opposed to a visual ASSET (a picture the product ships). Only these can
 * carry a `visual` verdict to HIGH confidence.
 */
const INTERFACE_RULES: ReadonlySet<string> = new Set([
  'visual.craft',
  'visual.quorum',
  'visual.surface',
]);

/**
 * Classifies the TYPE of work a mission goal asks for.
 *
 * Pure: no I/O, no clock, no randomness, no mutation of the input. Returns a
 * frozen verdict; the same goal always produces the same bytes.
 *
 * Returns `unknown` (never a guess) when the goal is too short or when no token
 * in the product vocabulary matches. See WORK_KIND_PRECEDENCE for how mixed
 * goals are resolved and why.
 */
export function classifyWorkKind(goal: string): WorkKindVerdict {
  const canonical = canonicalGoal(goal);
  if (canonical.length < MIN_CLASSIFIABLE_GOAL_CHARS) {
    return verdict(
      'unknown',
      'low',
      NO_SIGNALS,
      `Objetivo curto demais para classificar (< ${MIN_CLASSIFIABLE_GOAL_CHARS} caracteres uteis).`,
    );
  }

  const signals = collectSignals(canonical);
  const strong = signals.filter((signal) => signal.strength === 'strong');
  const tier: WorkKindSignalStrength = strong.length > 0 ? 'strong' : 'weak';
  const pool = strong.length > 0 ? strong : signals;
  const kind = firstByPrecedence(pool);

  if (!kind) {
    return verdict(
      'unknown',
      'low',
      NO_SIGNALS,
      'Nenhum sinal de tipo de trabalho reconhecido no objetivo.',
    );
  }

  const competingKinds = [
    ...new Set(
      pool.filter((signal) => signal.kind !== kind).map((s) => s.kind),
    ),
  ];
  const winningMatch =
    pool.find((signal) => signal.kind === kind)?.match ?? kind;
  const confidence: WorkKindConfidence =
    tier === 'strong' && competingKinds.length === 0 ? 'high' : 'low';

  return verdict(
    kind,
    confidence,
    signals,
    buildReason({ kind, tier, competingKinds, winningMatch }),
  );
}

export type DesignAuthorityRefusal =
  /** Not visual work at all. */
  | 'not-visual-work'
  /** Visual, but another kind competes — a hint, not a decision. */
  | 'low-confidence'
  /** Visual ASSET work (sprite/avatar/mascote): no interface to govern. */
  | 'asset-not-interface';

export interface DesignAuthorityDecision {
  /**
   * True when this mission must BOTH receive a house design contract and have
   * the `design-system` sensor required of it. There is deliberately no third
   * state: a required sensor with no contract to check is a red gate nobody
   * can turn green, and a contract nobody checks is dead prose.
   */
  readonly required: boolean;
  readonly verdict: WorkKindVerdict;
  /** Null exactly when `required` is true. */
  readonly refusal: DesignAuthorityRefusal | null;
}

/**
 * THE design-authority predicate — the single answer to "does this mission
 * deserve a design contract?".
 *
 * COHERENCE RULE (hard): whoever REQUIRES the design sensor must be whoever
 * CREATES the contract. `compileMissionContract` (which injects
 * `design-system`), `buildDesignContractBootstrap` (which writes the document)
 * and the guided work graph (which lets a task demand one) all call this one
 * function, so they cannot disagree about a goal. The bootstrap may still skip
 * for WORKSPACE reasons — a contract already exists, nothing hashable to bind
 * as evidence — but never because it read the goal differently.
 *
 * Deliberately STRICTER than `isUiWorkText`, the skill-grant predicate, and
 * the asymmetry is the point: a false positive there costs one unused skill, a
 * false positive here writes a DESIGN.md into a backend repository.
 * `requiresDesignAuthority(t)` therefore always implies `isUiWorkText(t)` —
 * asserted as an invariant in mission-work-kind.test.ts.
 */
export function decideDesignAuthority(text: string): DesignAuthorityDecision {
  const verdict = classifyWorkKind(text);
  const refuse = (refusal: DesignAuthorityRefusal): DesignAuthorityDecision =>
    Object.freeze({ required: false, verdict, refusal });

  if (verdict.kind !== 'visual') return refuse('not-visual-work');
  if (verdict.confidence !== 'high') return refuse('low-confidence');
  // A spritesheet mission is visual work, but it has no static interface for a
  // token contract to govern and no screen for the visual review contract to
  // screenshot. Granting it design authority hands it three obligations it
  // cannot fulfil.
  const hasInterfaceEvidence = verdict.signals.some(
    (signal) =>
      signal.strength === 'strong' && INTERFACE_RULES.has(signal.rule),
  );
  if (!hasInterfaceEvidence) return refuse('asset-not-interface');
  return Object.freeze({ required: true, verdict, refusal: null });
}

/**
 * Boolean shorthand for callers that hold TEXT and only need the verdict —
 * today the contract compiler, whose corpus is goal + domains + criteria.
 */
export function requiresDesignAuthority(text: string): boolean {
  return decideDesignAuthority(text).required;
}

/**
 * THE skill-grant predicate: does this mission touch an interface at all?
 *
 * Generous where the design-authority predicate is strict, because the costs
 * are asymmetric — a false positive here grants one unused skill, a false
 * positive there writes a DESIGN.md into a backend repository.
 *
 * The union is not decoration, it is the invariant made executable:
 * `requiresDesignAuthority(t)` ALWAYS implies `isUiMissionText(t)`. Without it,
 * `"criar a nova tela de cobrança"` received a design contract and the
 * `design-system` sensor while its roster got no design skill and no
 * anti-slop clause — the same shape of incoherence that made a backend CRUD
 * require a design sensor.
 *
 * `isUiWorkText` alone cannot express this: it never sees a verb, so it cannot
 * tell "criar a tela" (a UI build) from "corrigir o bug da tela de erro que
 * trava o backend" (a backend bug). That verb gating lives in the classifier,
 * behind the whole precedence table, which is why the union is taken here.
 */
export function isUiMissionText(text: string): boolean {
  return isUiWorkText(text) || requiresDesignAuthority(text);
}

/** Boundary guard for persisted/IPC values. */
export function isWorkKind(value: unknown): value is WorkKind {
  return (
    typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value)
  );
}
