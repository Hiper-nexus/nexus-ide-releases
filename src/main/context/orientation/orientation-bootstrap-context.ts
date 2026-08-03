import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlanLaneWritablePath } from '../../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  parseGuidedGreenfieldBrief,
  type GuidedGreenfieldApprovedIntent,
} from '../../runtime/guided-greenfield-brief';
import {
  ProcessGitRunner,
  assertSafeLocalGitConfig,
} from '../../runtime/git-command';
import { assertSha } from '../../runtime/worktree-contract';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import {
  GUIDED_GREENFIELD_INVARIANT,
  GUIDED_GREENFIELD_REQUIRED_DOCS,
  PROMOTED_PLAN_INVARIANT,
  type AuthorityProjectionBindings,
} from './orientation-authority-projection-spec';
import { renderAuthorityBootstrapProposal } from './orientation-authority-projection-renderer';
import { verifyAuthorityBootstrapProposal } from './orientation-authority-projection-verifier';
import type {
  BootstrapDocProposal,
  ContextBootstrapProposalOptions,
  SanctionedPromotedPlanBootstrapSource,
} from './orientation-bootstrap-types';
import type { ProjectOrientationMap } from './orientation-types';

export type {
  BootstrapDocProposal,
  ContextBootstrapProposalOptions,
  SanctionedPromotedPlanBootstrapSource,
} from './orientation-bootstrap-types';

const MAX_BOOTSTRAP_SOURCES = 4;
const MAX_BOOTSTRAP_SOURCE_BYTES = 1_000_000;
const NON_SEMANTIC_SOURCE_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'podfile.lock',
  'poetry.lock',
  'yarn.lock',
]);
const INTERNAL_SOURCE_SEGMENTS = new Set([
  '.claude',
  '.codex',
  '.context',
  '.gemini',
  '.peer-ade-app',
  '.worktrees',
  '.vite',
  'graphify-out',
  'release-assets',
]);

function sha256File(root: string, relative: string): string | null {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BOOTSTRAP_SOURCE_BYTES) {
      return null;
    }
    return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch {
    return null;
  }
}

function readCompleteSourceText(root: string, relative: string): string | null {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_BOOTSTRAP_SOURCE_BYTES
    ) return null;
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(fs.readFileSync(absolute));
    return content.trim() && !content.includes('\0') ? content : null;
  } catch {
    return null;
  }
}

interface ProductSource {
  readonly file: string;
  readonly content: string;
  readonly guidedIntent: GuidedGreenfieldApprovedIntent | null;
  readonly authorityKind:
    | 'repository-product-doc'
    | 'canonical-greenfield-brief'
    | 'promoted-plan';
}

function assertSanctionedPromotedPlanHead(
  root: string,
  source: SanctionedPromotedPlanBootstrapSource,
): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.headSha)) {
    throw new Error('sanctioned promoted plan has an invalid Git HEAD');
  }
  const git = new ProcessGitRunner();
  const topLevel = fs.realpathSync(
    git.run(root, ['rev-parse', '--show-toplevel']).stdout.trim(),
  );
  if (topLevel !== root) {
    throw new Error('sanctioned promoted plan is not bound to the exact Git root');
  }
  assertSafeLocalGitConfig(git, root);
  const currentHead = assertSha(
    git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'sanctioned promoted plan HEAD',
  );
  if (currentHead !== source.headSha) {
    throw new Error('sanctioned promoted plan Git HEAD changed before context proposal');
  }
  if (
    git.run(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--',
      source.file,
    ]).stdout.length > 0
  ) {
    throw new Error('sanctioned promoted plan became dirty before context proposal');
  }
  const committedContent = git.run(root, [
    'show',
    `${source.headSha}:${source.file}`,
  ]).stdout;
  if (
    committedContent !== source.content ||
    createHash('sha256').update(committedContent).digest('hex') !==
      source.sourceHash
  ) {
    throw new Error('sanctioned promoted plan changed in Git before context proposal');
  }
}

function findProductSource(
  scope: ProjectExecutionScope,
  options: ContextBootstrapProposalOptions,
): ProductSource | null {
  const root = scope.rootRealPath;
  const promoted = options.promotedPlanSource;
  if (promoted) {
    assertSanctionedPromotedPlanHead(root, promoted);
    let physical: { content: string; size: number };
    try {
      physical = readWorkspaceTextFile(scope, promoted.file);
    } catch {
      throw new Error(
        'sanctioned promoted plan changed before context proposal',
      );
    }
    const content =
      physical.size <= MAX_BOOTSTRAP_SOURCE_BYTES &&
      !physical.content.includes('\0') &&
      physical.content.trim()
        ? physical.content
        : null;
    const sourceHash = content
      ? createHash('sha256').update(content).digest('hex')
      : null;
    if (
      !isPlanLaneWritablePath(promoted.file) ||
      content !== promoted.content ||
      sourceHash !== promoted.sourceHash
    ) {
      throw new Error(
        'sanctioned promoted plan changed before context proposal',
      );
    }
    return {
      file: promoted.file,
      content: promoted.content,
      guidedIntent: promoted.approvedIntent,
      authorityKind: 'promoted-plan',
    };
  }
  for (const file of ['PRODUCT.md', 'README.md']) {
    const content = readCompleteSourceText(root, file);
    if (content) {
      const guidedIntent =
        file === GUIDED_GREENFIELD_BRIEF_PATH
          ? parseGuidedGreenfieldBrief(content)
          : null;
      return {
        file,
        content,
        guidedIntent,
        authorityKind: guidedIntent
          ? 'canonical-greenfield-brief'
          : 'repository-product-doc',
      };
    }
  }
  return null;
}

function collectSources(
  root: string,
  candidates: readonly string[],
): BootstrapDocProposal['sources'] {
  const sources: Array<{
    type: 'file';
    locator: string;
    sourceHash: string;
  }> = [];
  for (const locator of new Set(candidates)) {
    if (!isSafeBootstrapSourceLocator(locator)) continue;
    const hash = sha256File(root, locator);
    if (hash) sources.push({ type: 'file', locator, sourceHash: hash });
    if (sources.length >= MAX_BOOTSTRAP_SOURCES) break;
  }
  return Object.freeze(sources);
}

/** Bootstrap evidence must be authored source, never generated agent/runtime state. */
export function isSafeBootstrapSourceLocator(locator: string): boolean {
  const normalized = locator.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) return false;
  const segments = normalized.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return !segments.some((segment) => INTERNAL_SOURCE_SEGMENTS.has(segment)) &&
    !NON_SEMANTIC_SOURCE_BASENAMES.has(basename);
}

function greenfieldProjectionBindings(
  sourceContent: string,
  approvedIntent: GuidedGreenfieldApprovedIntent,
): AuthorityProjectionBindings {
  return Object.freeze({
    kind: 'greenfield',
    sourceFile: GUIDED_GREENFIELD_BRIEF_PATH,
    sourceContent,
    sourceHash: createHash('sha256').update(sourceContent).digest('hex'),
    approvedIntent,
    headSha: null,
  });
}

function promotedPlanProjectionBindings(
  source: SanctionedPromotedPlanBootstrapSource,
): AuthorityProjectionBindings {
  return Object.freeze({
    kind: 'promoted-plan',
    sourceFile: source.file,
    sourceContent: source.content,
    sourceHash: source.sourceHash,
    approvedIntent: source.approvedIntent,
    headSha: source.headSha,
  });
}

/**
 * A mechanical reviewer may approve only this exact, source-bound projection.
 * Any extra prose, source, target or byte drift falls back to independent CLI
 * or human review.
 */
export function isMechanicallyReviewableBootstrapProposal(
  scope: ProjectExecutionScope,
  proposal: BootstrapDocProposal,
  options: ContextBootstrapProposalOptions = {},
): boolean {
  if (options.promotedPlanSource) {
    const source = findProductSource(scope, options);
    if (source?.authorityKind !== 'promoted-plan') {
      return false;
    }
    return verifyAuthorityBootstrapProposal(
      proposal,
      promotedPlanProjectionBindings(options.promotedPlanSource),
    );
  }
  const source = readCompleteSourceText(
    scope.rootRealPath,
    GUIDED_GREENFIELD_BRIEF_PATH,
  );
  const intent = source ? parseGuidedGreenfieldBrief(source) : null;
  return Boolean(
    source &&
      intent &&
      verifyAuthorityBootstrapProposal(
        proposal,
        greenfieldProjectionBindings(source, intent),
      ),
  );
}

function buildAuthorityProposal(
  targetPath: string,
  bindings: AuthorityProjectionBindings,
  sources: BootstrapDocProposal['sources'],
): BootstrapDocProposal | null {
  return renderAuthorityBootstrapProposal(targetPath, bindings, sources);
}

/**
 * Deterministic context drafts from the structural map.
 * Never writes authority; only proposes content bound to real file hashes.
 */
export function buildContextBootstrapProposals(
  scope: ProjectExecutionScope,
  map: ProjectOrientationMap,
  options: ContextBootstrapProposalOptions = {},
): readonly BootstrapDocProposal[] {
  const root = scope.rootRealPath;
  const proposals: BootstrapDocProposal[] = [];
  const productSource = findProductSource(scope, options);

  const missing = new Set(map.docs.contextDocsMissing);
  if (
    productSource?.authorityKind === 'canonical-greenfield-brief' &&
    productSource.guidedIntent
  ) {
    const sources = collectSources(root, [GUIDED_GREENFIELD_BRIEF_PATH]);
    const bindings = greenfieldProjectionBindings(
      productSource.content,
      productSource.guidedIntent,
    );
    for (const targetPath of GUIDED_GREENFIELD_REQUIRED_DOCS) {
      if (!missing.has(targetPath)) continue;
      const proposal = buildAuthorityProposal(targetPath, bindings, sources);
      if (proposal) proposals.push(proposal);
    }
    if (!fileExists(root, GUIDED_GREENFIELD_INVARIANT)) {
      const invariant = buildAuthorityProposal(
        GUIDED_GREENFIELD_INVARIANT,
        bindings,
        sources,
      );
      if (invariant) proposals.push(invariant);
    }
    return Object.freeze(proposals);
  }
  if (
    productSource?.authorityKind === 'promoted-plan' &&
    productSource.guidedIntent &&
    options.promotedPlanSource
  ) {
    const sources = collectSources(root, [productSource.file]);
    const bindings = promotedPlanProjectionBindings(
      options.promotedPlanSource,
    );
    for (const targetPath of GUIDED_GREENFIELD_REQUIRED_DOCS) {
      if (!missing.has(targetPath)) continue;
      const proposal = buildAuthorityProposal(targetPath, bindings, sources);
      if (proposal) proposals.push(proposal);
    }
    if (!fileExists(root, PROMOTED_PLAN_INVARIANT)) {
      const invariant = buildAuthorityProposal(
        PROMOTED_PLAN_INVARIANT,
        bindings,
        sources,
      );
      if (invariant) proposals.push(invariant);
    }
    return Object.freeze(proposals);
  }
  const scripts = Object.entries(map.inventory.scripts)
    .map(([k, v]) => `- \`${k}\`: \`${v}\``)
    .join('\n');

  if (missing.has('.context/docs/project-overview.md')) {
    const sources = collectSources(root, [
      'package.json',
      ...(productSource ? [productSource.file] : []),
    ]);
    const content = [
      '# Project overview',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      '> Source-bound draft only — requires independent review before authority.',
      '',
      '## Bound sources',
      '',
      ...sources.map((source) => `- \`${source.locator}\``),
      '',
      '## Repository identity',
      '',
      sources.some((source) => source.locator === 'package.json')
        ? `The root \`package.json\` declares the package name \`${map.inventory.projectName ?? path.basename(root)}\`.`
        : 'No root package identity is asserted.',
      '',
      '## Product description',
      '',
      productSource
        ? `The following text is copied from \`${productSource.file}\` as unmodified product evidence:`
        : 'No product description is asserted because PRODUCT.md/README.md evidence is absent.',
      ...(productSource ? ['', productSource.content] : []),
      '',
    ].join('\n');
    if (sources.length > 0) {
      proposals.push(
        Object.freeze({
          targetPath: '.context/docs/project-overview.md',
          content,
          sources,
          rationale: 'Structural overview from orientation inventory',
        }),
      );
    }
  }

  if (missing.has('.context/docs/architecture.md')) {
    const sources = collectSources(root, [
      'package.json',
      ...map.inventory.entrypoints,
      ...map.symbols.hubs.flatMap((hub) => hub.samplePaths),
    ]);
    const content = [
      '# Architecture',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      '> Only the hashed files listed below are asserted as structural anchors.',
      '',
      '## Bound structural anchors',
      '',
      ...sources.map((source) => `- \`${source.locator}\``),
      '',
      'No runtime topology, deployment boundary or business behavior is asserted beyond the contents of those files.',
      '',
      '## Selected root runtime scripts',
      '',
      sources.some((source) => source.locator === 'package.json')
        ? (scripts || '- No operational scripts were selected from `package.json`.')
        : '- No root `package.json` is bound, so no Node.js runtime scripts are asserted.',
      '',
    ].join('\n');
    if (sources.length > 0) {
      proposals.push(
        Object.freeze({
          targetPath: '.context/docs/architecture.md',
          content,
          sources,
          rationale: 'Architecture draft from hubs and import graph',
        }),
      );
    }
  }

  if (missing.has('.context/docs/testing.md')) {
    const testScripts = Object.entries(map.inventory.scripts)
      .filter(([k]) => /test|typecheck|lint|check/i.test(k))
      .map(([k, v]) => `- \`${k}\`: \`${v}\``)
      .join('\n');
    const sources = collectSources(root, map.inventory.manifests);
    const isPackageJsonBound = sources.some((source) => source.locator === 'package.json');
    const content = [
      '# Testing',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      '',
      '## Bound manifests',
      '',
      ...sources.map((source) => `- \`${source.locator}\``),
      '',
      '## Selected verification scripts from the root `package.json`',
      '',
      isPackageJsonBound
        ? (testScripts || '- No test/typecheck scripts were selected from the root `package.json`.')
        : '- No root `package.json` is bound, so no scripts are asserted. Document how to verify changes.',
      '',
      '## Minimum bar',
      '',
      '- Prefer automated unit/typecheck sensors configured in `.context/config/sensors.json`.',
      '- Do not claim green without Nexus sensor evidence.',
      '',
    ].join('\n');
    if (sources.length > 0) {
      proposals.push(
        Object.freeze({
          targetPath: '.context/docs/testing.md',
          content,
          sources,
          rationale: 'Testing draft from package scripts',
        }),
      );
    }
  }

  if (missing.has('.context/docs/business-model.md')) {
    const content = productSource
      ? [
          '# Business model',
          '',
          `> Source-bound product context copied from \`${productSource.file}\`.`,
          '> Independent review must reject any claim not present in that source.',
          '',
          productSource.content,
          '',
          '## Explicit unknowns',
          '',
          '- Revenue, pricing, billing and tenancy rules are not asserted unless the source above states them.',
          '',
        ].join('\n')
      : [
          '# Business model',
          '',
          `> Auto-proposed skeleton from orientation (${map.mapHash.slice(0, 12)}).`,
          '> Product authority is absent from the repository.',
          '',
          '- TODO: add source-backed customers, value and non-negotiable rules.',
          '',
        ].join('\n');
    const sources = collectSources(
      root,
      productSource
        ? [productSource.file]
        : (map.docs.rootDocs.length > 0 ? [map.docs.rootDocs[0]] : map.inventory.manifests),
    );
    if (sources.length > 0) {
      proposals.push(
        Object.freeze({
          targetPath: '.context/docs/business-model.md',
          content,
          sources,
          rationale: 'Business skeleton requiring human/product review',
        }),
      );
    }
  }

  if (missing.has('.context/docs/domain-glossary.md')) {
    const sources = collectSources(
      root,
      map.symbols.hubs.flatMap((hub) => hub.samplePaths),
    );
    const boundLocators = new Set(sources.map((source) => source.locator));
    const terms = map.symbols.hubs
      .filter((hub) => hub.samplePaths.some((sample) => boundLocators.has(sample)))
      .slice(0, MAX_BOOTSTRAP_SOURCES)
      .map((hub) => {
        const sample = hub.samplePaths.find((candidate) => boundLocators.has(candidate))!;
        return `- **${hub.name}**: observed code symbol in \`${sample}\`; no business meaning is asserted.`;
      })
      .join('\n');
    const content = [
      '# Domain glossary',
      '',
      `> Auto-proposed term list from code hubs (${map.mapHash.slice(0, 12)}).`,
      '',
      terms || '- No source-bound code term is asserted.',
      '',
    ].join('\n');
    if (sources.length > 0) {
      proposals.push(
        Object.freeze({
          targetPath: '.context/docs/domain-glossary.md',
          content,
          sources,
          rationale: 'Glossary seeds from symbol hubs',
        }),
      );
    }
  }

  // High-confidence structural invariant from package.json (closes readiness gap).
  const packageSources = collectSources(root, ['package.json']);
  if (
    packageSources.length > 0 &&
    map.inventory.projectName &&
    !fileExists(root, '.context/nexus/invariants/package-name.json')
  ) {
    const fact = {
      schemaVersion: 1 as const,
      facts: [
        {
          id: 'inv:package-name',
          statement: `Repository package name is "${map.inventory.projectName}" as declared in package.json.`,
          claimKey: 'package.name',
          value: map.inventory.projectName,
          kind: 'observed' as const,
          category: 'invariant' as const,
          domains: ['repository'],
          relatedSymbols: [] as string[],
          confidence: 1,
        },
      ],
    };
    proposals.push(
      Object.freeze({
        targetPath: '.context/nexus/invariants/package-name.json',
        content: `${JSON.stringify(fact, null, 2)}\n`,
        sources: packageSources,
        rationale: 'Observed package name invariant from package.json',
      }),
    );
  }

  // Observed scripts invariant when test/typecheck exist.
  const scriptKeys = Object.keys(map.inventory.scripts).sort();
  if (
    packageSources.length > 0 &&
    scriptKeys.length > 0 &&
    !fileExists(root, '.context/nexus/invariants/package-scripts.json')
  ) {
    const fact = {
      schemaVersion: 1 as const,
      facts: [
        {
          id: 'inv:package-scripts',
          statement: `Selected operational scripts from package.json: ${scriptKeys.join(', ')}.`,
          claimKey: 'package.scripts.selected',
          value: scriptKeys,
          kind: 'observed' as const,
          category: 'invariant' as const,
          domains: ['repository', 'testing'],
          relatedSymbols: [] as string[],
          confidence: 1,
        },
      ],
    };
    proposals.push(
      Object.freeze({
        targetPath: '.context/nexus/invariants/package-scripts.json',
        content: `${JSON.stringify(fact, null, 2)}\n`,
        sources: packageSources,
        rationale: 'Observed package scripts from package.json',
      }),
    );
  }

  return Object.freeze(proposals);
}

function fileExists(root: string, relative: string): boolean {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Drafts with TODO product placeholders must not enter autonomous approve loops. */
export function isAutoReviewableBootstrapProposal(
  proposal: BootstrapDocProposal,
): boolean {
  if (/\bTODO\b/.test(proposal.content)) return false;
  // Glossary with TODO markers is product work, not structural truth.
  if (proposal.targetPath.includes('domain-glossary') && /\bTODO\b/.test(proposal.content)) {
    return false;
  }
  return proposal.sources.length > 0;
}
