import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { ProjectOrientationMap } from './orientation-types';

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
  '.overclock-app',
  '.worktrees',
  '.vite',
  'graphify-out',
  'release-assets',
]);

export interface BootstrapDocProposal {
  readonly targetPath: string;
  readonly content: string;
  readonly sources: readonly {
    readonly type: 'file';
    readonly locator: string;
    readonly sourceHash: string;
  }[];
  readonly rationale: string;
}

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
    const content = new TextDecoder('utf-8', { fatal: true })
      .decode(fs.readFileSync(absolute));
    return content.trim() && !content.includes('\0') ? content : null;
  } catch {
    return null;
  }
}

function findProductSource(root: string): { file: string; content: string } | null {
  for (const file of ['PRODUCT.md', 'README.md']) {
    const content = readCompleteSourceText(root, file);
    if (content) return { file, content };
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

/**
 * Deterministic context drafts from the structural map.
 * Never writes authority; only proposes content bound to real file hashes.
 */
export function buildContextBootstrapProposals(
  scope: ProjectExecutionScope,
  map: ProjectOrientationMap,
): readonly BootstrapDocProposal[] {
  const root = scope.rootRealPath;
  const proposals: BootstrapDocProposal[] = [];
  const productSource = findProductSource(root);

  const missing = new Set(map.docs.contextDocsMissing);
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
