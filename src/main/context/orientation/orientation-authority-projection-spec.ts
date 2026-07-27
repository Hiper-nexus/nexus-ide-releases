import { createHash } from 'node:crypto';
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  type GuidedGreenfieldApprovedIntent,
} from '../../runtime/guided-greenfield-brief';

export const GUIDED_GREENFIELD_REQUIRED_DOCS = Object.freeze([
  '.context/docs/project-overview.md',
  '.context/docs/business-model.md',
  '.context/docs/domain-glossary.md',
  '.context/docs/architecture.md',
  '.context/docs/testing.md',
]);
export const GUIDED_GREENFIELD_INVARIANT =
  '.context/nexus/invariants/greenfield-authority-integrity.json';
export const PROMOTED_PLAN_INVARIANT =
  '.context/nexus/invariants/promoted-plan-authority.json';

export type AuthorityProjectionKind = 'greenfield' | 'promoted-plan';

export interface AuthorityProjectionBindings {
  readonly kind: AuthorityProjectionKind;
  readonly sourceFile: string;
  readonly sourceContent: string;
  readonly sourceHash: string;
  readonly approvedIntent: GuidedGreenfieldApprovedIntent;
  readonly headSha: string | null;
}

export type AuthorityMarkdownBlock =
  | Readonly<{
      kind: 'heading';
      level: 1 | 2;
      text: string;
    }>
  | Readonly<{
      kind: 'blockquote';
      lines: readonly string[];
    }>
  | Readonly<{
      kind: 'bullet-list';
      items: readonly string[];
    }>
  | Readonly<{
      kind: 'json-code';
      value: string;
    }>
  | Readonly<{
      kind: 'verbatim-source';
      value: string;
    }>;

export type AuthorityProjectionAst =
  | Readonly<{
      format: 'markdown';
      targetPath: string;
      rationale: string;
      allowedSections: readonly string[];
      blocks: readonly AuthorityMarkdownBlock[];
    }>
  | Readonly<{
      format: 'json';
      targetPath: string;
      rationale: string;
      document: Readonly<{
        schemaVersion: 1;
        facts: readonly Readonly<{
          id: string;
          statement: string;
          claimKey: string;
          value: string;
          kind: 'asserted';
          category: 'invariant';
          domains: readonly string[];
          relatedSymbols: readonly string[];
          confidence: 1;
        }>[];
      }>;
    }>;

interface MarkdownProjectionSpec {
  readonly title: string;
  readonly rationale: string;
  readonly intentHeading?: string;
  readonly includeConstraints?: boolean;
  readonly includeVerbatimSource?: boolean;
  readonly unknowns: readonly string[];
}

const GREENFIELD_DOC_SPECS: Readonly<Record<string, MarkdownProjectionSpec>> =
  Object.freeze({
    '.context/docs/project-overview.md': Object.freeze({
      title: 'Project overview',
      rationale: 'Exact greenfield overview projected from the approved source brief',
      intentHeading: 'Exact approved delivery intent',
      unknowns: Object.freeze([
        'Product shape, users and domain behavior beyond the approved intent are unknown.',
        'The repository has no implementation identity asserted by this document.',
      ]),
    }),
    '.context/docs/business-model.md': Object.freeze({
      title: 'Business model',
      rationale: 'Honest business-context boundary from the approved source brief',
      intentHeading: 'Approved delivery boundary',
      unknowns: Object.freeze([
        'Customers, value exchange, revenue, pricing, billing and tenancy are unknown unless stated verbatim in the approved intent.',
        'No market, commercial or regulatory claim is inferred from the requested delivery.',
      ]),
    }),
    '.context/docs/domain-glossary.md': Object.freeze({
      title: 'Domain glossary',
      rationale: 'Glossary boundary without invented domain definitions',
      intentHeading: 'Exact approved vocabulary source',
      unknowns: Object.freeze([
        'No canonical domain term or synonym is introduced by this draft.',
        'Domain nouns remain undefined until implementation evidence or a later independently reviewed product source defines them.',
      ]),
    }),
    '.context/docs/architecture.md': Object.freeze({
      title: 'Architecture',
      rationale: 'Technical boundary without an invented greenfield stack',
      intentHeading: 'Exact approved delivery boundary',
      unknowns: Object.freeze([
        'Language, runtime, framework, dependencies and module boundaries are not selected.',
        'Data, network, security, deployment and operational topology are unknown.',
        'Implementers must derive and validate the smallest architecture that satisfies the approved criteria; this document does not pre-authorize a stack.',
      ]),
    }),
    '.context/docs/testing.md': Object.freeze({
      title: 'Testing',
      rationale: 'Verification boundary from exact approved acceptance criteria',
      intentHeading: 'Outcomes that require verification',
      unknowns: Object.freeze([
        'Test framework, commands, fixtures, environments and coverage targets are not selected.',
        'Passing claims require Nexus sensor evidence after the implementation chooses real verification commands.',
      ]),
    }),
  });

const PROMOTED_PLAN_DOC_SPECS: Readonly<
  Record<string, MarkdownProjectionSpec>
> = Object.freeze({
  '.context/docs/project-overview.md': Object.freeze({
    title: 'Project overview',
    rationale: 'Verbatim overview from the sealed, committed promoted PRD',
    intentHeading: 'Exact approved mission intent',
    includeConstraints: true,
    includeVerbatimSource: true,
    unknowns: Object.freeze([
      'Any product behavior, user, domain rule or delivery scope absent from the approved intent and promoted PRD remains unknown.',
    ]),
  }),
  '.context/docs/business-model.md': Object.freeze({
    title: 'Business model',
    rationale: 'Business boundary preserving the promoted PRD without inferred claims',
    includeConstraints: true,
    includeVerbatimSource: true,
    unknowns: Object.freeze([
      'Customers, value exchange, revenue, pricing, billing and tenancy remain unknown unless stated explicitly in the PRD above.',
      'No market, commercial, legal or regulatory claim is inferred.',
    ]),
  }),
  '.context/docs/domain-glossary.md': Object.freeze({
    title: 'Domain glossary',
    rationale: 'Verbatim PRD vocabulary evidence without invented definitions',
    includeVerbatimSource: true,
    unknowns: Object.freeze([
      'No glossary definition, synonym or canonical domain meaning is inferred from prose.',
      'Terms remain undefined unless the PRD above defines them explicitly.',
    ]),
  }),
  '.context/docs/architecture.md': Object.freeze({
    title: 'Architecture',
    rationale: 'Technical boundary preserving only explicit promoted-PRD authority',
    includeConstraints: true,
    includeVerbatimSource: true,
    unknowns: Object.freeze([
      'Language, runtime, framework, dependencies and module boundaries remain unselected unless the PRD states them explicitly.',
      'Data, network, security, deployment and operational topology are not inferred.',
    ]),
  }),
  '.context/docs/testing.md': Object.freeze({
    title: 'Testing',
    rationale: 'Verification boundary from exact approved criteria and promoted PRD',
    intentHeading: 'Exact approved acceptance criteria',
    includeConstraints: true,
    includeVerbatimSource: true,
    unknowns: Object.freeze([
      'Test framework, commands, fixtures, environments and coverage targets remain unselected unless stated explicitly above.',
      'Passing claims require Nexus sensor evidence from the implemented system.',
    ]),
  }),
});

function approvedIntentJson(
  intent: GuidedGreenfieldApprovedIntent,
): string {
  return JSON.stringify(
    {
      goal: intent.goal,
      acceptanceCriteria: intent.acceptanceCriteria,
    },
    null,
    2,
  )
    .replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c');
}

function normalizedHeading(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isExplicitConstraintHeading(value: string): boolean {
  const heading = normalizedHeading(value);
  return (
    /\bconstraints?\b/.test(heading) ||
    /\brestricoes?\b/.test(heading) ||
    /\binvariants?\b/.test(heading) ||
    /\binvariantes?\b/.test(heading) ||
    /\bacceptance criteria\b/.test(heading) ||
    /\bcriterios? de aceite\b/.test(heading) ||
    /\bcriterios? nao negociaveis?\b/.test(heading) ||
    /\bnon functional requirements?\b/.test(heading) ||
    /\brequisitos? nao funcionais?\b/.test(heading) ||
    /\bsecurity requirements?\b/.test(heading) ||
    /\brequisitos? de seguranca\b/.test(heading)
  );
}

function explicitConstraints(content: string): readonly string[] {
  const values: string[] = [];
  let insideExplicitSection = false;
  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      insideExplicitSection = isExplicitConstraintHeading(heading[2]!);
      continue;
    }
    if (!insideExplicitSection) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line)?.[1];
    if (
      !item ||
      /^(?:\[\s\]|\[[-?~]\])\s*/.test(item) ||
      /\bTODO\b/i.test(item)
    ) {
      continue;
    }
    const exact = item.replace(/^\[[xX]\]\s*/, '').trim();
    if (exact && !values.includes(exact)) values.push(exact);
    if (values.length >= 32) break;
  }
  return Object.freeze(values);
}

function heading(level: 1 | 2, text: string): AuthorityMarkdownBlock {
  return Object.freeze({ kind: 'heading', level, text });
}

function bulletList(items: readonly string[]): AuthorityMarkdownBlock {
  return Object.freeze({ kind: 'bullet-list', items: Object.freeze([...items]) });
}

function markdownProjection(
  bindings: AuthorityProjectionBindings,
  targetPath: string,
  spec: MarkdownProjectionSpec,
): AuthorityProjectionAst {
  const blocks: AuthorityMarkdownBlock[] = [
    heading(1, spec.title),
    Object.freeze({
      kind: 'blockquote',
      lines:
        bindings.kind === 'greenfield'
          ? Object.freeze([
              `Deterministic Nexus draft bound only to \`${GUIDED_GREENFIELD_BRIEF_PATH}\`.`,
              'Independent mechanical review verifies byte-for-byte derivation before this becomes context authority.',
            ])
          : Object.freeze([
              `Deterministic Nexus draft bound only to the promoted and committed \`${bindings.sourceFile}\`.`,
              `Git HEAD: \`${bindings.headSha}\`; PRD SHA-256: \`${bindings.sourceHash}\`.`,
              'This draft preserves the PRD verbatim and adds only explicit unknowns; independent review is required.',
            ]),
    }),
  ];
  if (bindings.kind === 'greenfield') {
    blocks.push(
      heading(2, 'Bound source'),
      bulletList([`\`${GUIDED_GREENFIELD_BRIEF_PATH}\``]),
    );
  }
  if (spec.intentHeading) {
    blocks.push(
      heading(2, spec.intentHeading),
      Object.freeze({
        kind: 'json-code',
        value: approvedIntentJson(bindings.approvedIntent),
      }),
    );
  }
  if (spec.includeConstraints) {
    const constraints = explicitConstraints(bindings.sourceContent);
    blocks.push(
      heading(2, 'Explicit constraints copied verbatim'),
      bulletList(
        constraints.length > 0
          ? constraints
          : [
              'No constraint list was found under an explicit constraints or acceptance heading.',
            ],
      ),
    );
  }
  if (spec.includeVerbatimSource) {
    blocks.push(
      heading(2, 'Exact promoted PRD (verbatim)'),
      Object.freeze({
        kind: 'verbatim-source',
        value: bindings.sourceContent,
      }),
    );
  }
  blocks.push(
    heading(2, 'Explicit unknowns'),
    bulletList(spec.unknowns),
  );
  return Object.freeze({
    format: 'markdown',
    targetPath,
    rationale: spec.rationale,
    allowedSections: Object.freeze(
      blocks.flatMap((block) =>
        block.kind === 'heading' && block.level === 2 ? [block.text] : [],
      ),
    ),
    blocks: Object.freeze(blocks),
  });
}

function invariantProjection(
  bindings: AuthorityProjectionBindings,
  targetPath: string,
): AuthorityProjectionAst | null {
  const isGreenfield = bindings.kind === 'greenfield';
  if (
    targetPath !==
    (isGreenfield ? GUIDED_GREENFIELD_INVARIANT : PROMOTED_PLAN_INVARIANT)
  ) {
    return null;
  }
  return Object.freeze({
    format: 'json',
    targetPath,
    rationale: isGreenfield
      ? 'Nexus governance binding for the canonical greenfield brief'
      : 'Nexus governance binding for the exact promoted PRD authority',
    document: Object.freeze({
      schemaVersion: 1,
      facts: Object.freeze([
        Object.freeze({
          id: isGreenfield
            ? 'inv:greenfield-authority-integrity'
            : 'inv:promoted-plan-authority-integrity',
          statement: isGreenfield
            ? 'Nexus authority integrity requires the approved goal, acceptance criteria and canonical PRODUCT.md SHA-256 to remain unchanged unless a new user approval creates new mission authority.'
            : 'Nexus authority integrity requires the approved goal, acceptance criteria and promoted PRD SHA-256 to remain unchanged unless a new user approval creates new mission authority.',
          claimKey: isGreenfield
            ? 'nexus.authority.greenfieldBriefSha256'
            : 'nexus.authority.promotedPlanSha256',
          value: bindings.sourceHash,
          kind: 'asserted',
          category: 'invariant',
          domains: Object.freeze(['nexus-governance']),
          relatedSymbols: Object.freeze([]),
          confidence: 1,
        }),
      ]),
    }),
  });
}

export function buildCanonicalAuthorityProjection(
  targetPath: string,
  bindings: AuthorityProjectionBindings,
): AuthorityProjectionAst | null {
  if (
    createHash('sha256').update(bindings.sourceContent).digest('hex') !==
      bindings.sourceHash ||
    (bindings.kind === 'greenfield' &&
      bindings.sourceFile !== GUIDED_GREENFIELD_BRIEF_PATH) ||
    (bindings.kind === 'promoted-plan' && !bindings.headSha)
  ) {
    return null;
  }
  const invariant = invariantProjection(bindings, targetPath);
  if (invariant) return invariant;
  const spec =
    bindings.kind === 'greenfield'
      ? GREENFIELD_DOC_SPECS[targetPath]
      : PROMOTED_PLAN_DOC_SPECS[targetPath];
  return spec ? markdownProjection(bindings, targetPath, spec) : null;
}
