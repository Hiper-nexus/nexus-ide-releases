import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { ProjectOrientationMap } from './orientation-types';

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
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
      return null;
    }
    return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch {
    return null;
  }
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
  for (const locator of candidates) {
    const hash = sha256File(root, locator);
    if (hash) sources.push({ type: 'file', locator, sourceHash: hash });
    if (sources.length >= 8) break;
  }
  return Object.freeze(sources);
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
  const sourceCandidates = [
    ...map.inventory.manifests,
    ...map.inventory.entrypoints,
    ...map.docs.rootDocs,
    ...map.symbols.hubs.flatMap((h) => h.samplePaths).slice(0, 12),
  ];

  const missing = new Set(map.docs.contextDocsMissing);
  const languages = map.inventory.languages
    .map((l) => `${l.id} (${l.files} files)`)
    .join(', ');
  const hubs = map.symbols.hubs
    .slice(0, 12)
    .map((h) => `- ${h.name} — ${h.samplePaths[0] ?? '?'}`)
    .join('\n');
  const dirs = map.inventory.topDirs
    .map((d) => `- \`${d.path}/\` (${d.files} files)`)
    .join('\n');
  const scripts = Object.entries(map.inventory.scripts)
    .map(([k, v]) => `- \`${k}\`: \`${v}\``)
    .join('\n');
  const entrypoints = map.inventory.entrypoints.map((e) => `- \`${e}\``).join('\n');

  if (missing.has('.context/docs/project-overview.md')) {
    const content = [
      '# Project overview',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      `> Structural draft only — requires independent review before authority.`,
      '',
      `**Name:** ${map.inventory.projectName ?? path.basename(root)}`,
      `**Languages:** ${languages || 'unknown'}`,
      `**Package managers:** ${map.inventory.packageManagers.join(', ') || 'unknown'}`,
      '',
      '## What this repository appears to be',
      '',
      'This draft was generated from the repository tree, manifests and symbol hubs.',
      'Replace this paragraph with the real product pitch after review.',
      '',
      '## Top directories',
      '',
      dirs || '- (none)',
      '',
      '## Entrypoints',
      '',
      entrypoints || '- (none detected)',
      '',
    ].join('\n');
    const sources = collectSources(root, sourceCandidates);
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
    const edges = map.graph.sampleEdges
      .slice(0, 16)
      .map((e) => `- \`${e.from}\` → \`${e.to}\` (${e.relation})`)
      .join('\n');
    const content = [
      '# Architecture',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      `> Not business authority until reviewed.`,
      '',
      '## Languages and scale',
      '',
      languages || 'unknown',
      '',
      '## Directory layout',
      '',
      dirs || '- (none)',
      '',
      '## Symbol hubs (likely core modules)',
      '',
      hubs || '- (none)',
      '',
      '## Import sketch',
      '',
      edges || '- (import graph not available)',
      '',
      '## Runtime scripts',
      '',
      scripts || '- (none)',
      '',
    ].join('\n');
    const sources = collectSources(root, sourceCandidates);
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
    const content = [
      '# Testing',
      '',
      `> Auto-proposed by Nexus orientation map (${map.mapHash.slice(0, 12)}).`,
      '',
      '## Declared scripts',
      '',
      testScripts ||
        '- No test/typecheck scripts found in package manifests. Document how to verify changes.',
      '',
      '## Minimum bar',
      '',
      '- Prefer automated unit/typecheck sensors configured in `.context/config/sensors.json`.',
      '- Do not claim green without Nexus sensor evidence.',
      '',
    ].join('\n');
    const sources = collectSources(root, [
      ...map.inventory.manifests,
      ...map.docs.rootDocs,
    ]);
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
    const content = [
      '# Business model',
      '',
      `> Auto-proposed skeleton from orientation (${map.mapHash.slice(0, 12)}).`,
      `> Must be rewritten with real product/revenue rules before authority.`,
      '',
      '## Customers',
      '',
      '- TODO: who pays / who uses this product?',
      '',
      '## Value',
      '',
      '- TODO: what job is completed for the customer?',
      '',
      '## Constraints',
      '',
      '- TODO: non-negotiable business rules (tenancy, billing, privacy).',
      '',
    ].join('\n');
    const sources = collectSources(root, map.docs.rootDocs.length > 0
      ? map.docs.rootDocs
      : map.inventory.manifests);
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
    const terms = map.symbols.hubs
      .slice(0, 20)
      .map((h) => `- **${h.name}**: TODO — define domain meaning (code hub at \`${h.samplePaths[0] ?? '?'}\`)`)
      .join('\n');
    const content = [
      '# Domain glossary',
      '',
      `> Auto-proposed term list from code hubs (${map.mapHash.slice(0, 12)}).`,
      '',
      terms || '- TODO: add domain terms',
      '',
    ].join('\n');
    const sources = collectSources(root, sourceCandidates);
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
          statement: `package.json declares scripts: ${scriptKeys.join(', ')}.`,
          claimKey: 'package.scripts',
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
  if (proposal.targetPath.includes('business-model')) return false;
  // Glossary with TODO markers is product work, not structural truth.
  if (proposal.targetPath.includes('domain-glossary') && /\bTODO\b/.test(proposal.content)) {
    return false;
  }
  return proposal.sources.length > 0;
}
