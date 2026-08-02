import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  DESIGN_ADAPTATION_NOTICE,
  sanitizeDesignCommentValue,
} from './design-kit-source';
import { readWorkspaceTextFile } from '../orch/workspace-file';

/**
 * DOES THIS PROJECT ALREADY HAVE A DESIGN SYSTEM OF ITS OWN — AND IF SO, WHAT
 * IS IT?
 *
 * WHY THIS EXISTS (H5)
 * --------------------
 * The bootstrap pilot only stepped aside when a DESIGN.md was already on disk.
 * A mature repository with its own CSS, its own palette and its own identity —
 * but no DESIGN.md — got the neutral HOUSE floor written over it. And the house
 * floor is not inert: `scripts/design-system-sensor.mjs` re-reads whatever the
 * contract declares and demands that every token in it appear in the project's
 * style files. So the sensor immediately went red, permanently, with findings
 * like `spacing tokens not found: 1px, 75rem…` and `custom-property tokens not
 * found: --color-canvas, --color-surface…`. The mission had asked to change one
 * colour; the product answered by requiring the entire application to be
 * re-tokenized into a vocabulary Nexus had just invented.
 *
 * THE DECISION: DERIVE, DO NOT IMPOSE
 * -----------------------------------
 * Two options were on the table. "Do not impose the floor" (write nothing) was
 * rejected: the sensor's FIRST check is that a contract file exists at all, so
 * writing nothing leaves the same red, and a visual mission still has no
 * authority to build against. So the contract is DERIVED: Nexus reads the
 * tokens the project actually declares and writes them down as the contract.
 *
 * That satisfies the sensor by construction — every token in the document was
 * copied out of a style file, so it cannot fail to be found in one — and it is
 * the honest reading of the owner's requirement, which is "do not look like it
 * was made by an AI", not "use the house vocabulary". A project that already
 * has an identity does not need one issued to it; it needs the one it has
 * written down so the next mission stops inventing a seventh grey.
 *
 * The third-party kit catalog is deliberately NOT consulted on this path: a
 * project with its own system must never be pointed at somebody else's brand.
 *
 * DETERMINISM
 * -----------
 * The whole module is a pure function of the filesystem: sorted traversal,
 * bounded reads, first-declaration-wins, one chosen token file. The mechanical
 * reviewer re-derives the contract and demands the same bytes, so any
 * non-determinism here would be a permanent rejection loop, not a cosmetic bug.
 */

/** Directories that never hold authored product style. Mirrors the sensor. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.nexus',
  '.vercel',
  '.netlify',
  '.output',
  'coverage',
  'storybook-static',
  '.expo',
  'playwright-report',
  'test-results',
  '.cache',
  '.context',
]);

const STYLE_EXTENSIONS: readonly string[] = ['.css', '.scss', '.less', '.styl'];

const TAILWIND_CONFIG_RE = /^tailwind\.config\.(?:js|cjs|mjs|ts|mts|cts)$/i;

/** Traversal bounds: this runs in the main process on every doctor pass. */
const MAX_VISITED_ENTRIES = 20_000;
const MAX_STYLE_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Below this, a handful of stray custom properties is not a design system —
 * it is a component with two variables, and deriving a "contract" from it would
 * be as much of an invention as the house floor.
 */
export const MIN_PROJECT_DESIGN_TOKENS = 8;

/** Bounded document: a 400-token contract is a dump, not authority. */
const MAX_CONTRACT_TOKENS = 120;

export interface ProjectDesignToken {
  /** `--color-canvas` */
  readonly name: string;
  /** Declaration value, copied verbatim from the style file. */
  readonly value: string;
}

export interface ProjectDesignSystemProbe {
  /** Workspace-relative style file the tokens were read from; null when the
   *  only evidence is a Tailwind config. */
  readonly tokenSourceLocator: string | null;
  readonly tokens: readonly ProjectDesignToken[];
  readonly tailwindConfigLocator: string | null;
}

/**
 * Values are project-authored text that lands in a Markdown table. Rather than
 * escaping them — which would break the sensor invariant that every value in
 * the document also appears verbatim in a style file — anything outside this
 * conservative charset is DROPPED. Real CSS values never leave it.
 */
const SAFE_TOKEN_VALUE = /^[A-Za-z0-9 ()%,./#*+_'"-]+$/;
const SAFE_TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;
const MAX_TOKEN_VALUE_CHARS = 200;

/** `:root { … }` blocks only: these are the project's GLOBAL tokens. */
const ROOT_BLOCK_RE = /:root\b[^{}]*\{([^{}]*)\}/g;
const CUSTOM_PROPERTY_RE = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;

function isStyleFile(name: string): boolean {
  const lower = name.toLowerCase();
  return STYLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

interface WalkResult {
  readonly styleFiles: readonly string[];
  readonly tailwindConfigLocator: string | null;
}

/**
 * Sorted, symlink-free, bounded traversal. Symlinks are skipped entirely: a
 * link that escapes the workspace would let content outside the scope decide
 * what a project's design authority says.
 */
function walkStyleSurface(root: string): WalkResult {
  const styleFiles: string[] = [];
  let tailwindConfigLocator: string | null = null;
  let visited = 0;
  const queue: string[] = [''];

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relativeDir), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (++visited > MAX_VISITED_ENTRIES) return freezeWalk(styleFiles, tailwindConfigLocator);
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (tailwindConfigLocator === null && TAILWIND_CONFIG_RE.test(entry.name)) {
        tailwindConfigLocator = relative;
        continue;
      }
      if (!isStyleFile(entry.name)) continue;
      if (styleFiles.length >= MAX_STYLE_FILES) continue;
      styleFiles.push(relative);
    }
  }
  return freezeWalk(styleFiles, tailwindConfigLocator);
}

function freezeWalk(
  styleFiles: readonly string[],
  tailwindConfigLocator: string | null,
): WalkResult {
  return Object.freeze({
    styleFiles: Object.freeze([...styleFiles].sort()),
    tailwindConfigLocator,
  });
}

/** First declaration wins, so a light `:root` beats its dark override. */
function extractRootTokens(content: string): readonly ProjectDesignToken[] {
  const seen = new Map<string, string>();
  for (const block of content.matchAll(ROOT_BLOCK_RE)) {
    const body = block[1] ?? '';
    for (const declaration of body.matchAll(CUSTOM_PROPERTY_RE)) {
      const name = declaration[1] ?? '';
      const value = (declaration[2] ?? '').replace(/\s+/g, ' ').trim();
      if (!SAFE_TOKEN_NAME.test(name)) continue;
      if (value === '' || value.length > MAX_TOKEN_VALUE_CHARS) continue;
      if (!SAFE_TOKEN_VALUE.test(value)) continue;
      if (seen.has(name)) continue;
      seen.set(name, value);
    }
  }
  return Object.freeze(
    [...seen.entries()].map(([name, value]) =>
      Object.freeze({ name, value }),
    ),
  );
}

function readBoundedText(
  scope: ProjectExecutionScope,
  relative: string,
): string | null {
  try {
    const absolute = path.join(scope.rootRealPath, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return readWorkspaceTextFile(scope, relative).content;
  } catch {
    return null;
  }
}

/**
 * Answers "does this project already have a design system?" and, when it does,
 * hands back the single file that best represents it.
 *
 * ONE file, not a merge of all of them: merging invites cross-file name
 * collisions where the same token has two values, and the sensor's drift check
 * compares the document against ONE `:root`. The winner is the style file that
 * declares the most global tokens; ties break on the sorted path so the answer
 * never depends on traversal order.
 */
export function probeProjectDesignSystem(
  scope: ProjectExecutionScope,
): ProjectDesignSystemProbe | null {
  const walk = walkStyleSurface(scope.rootRealPath);

  let best: { locator: string; tokens: readonly ProjectDesignToken[] } | null =
    null;
  for (const locator of walk.styleFiles) {
    const content = readBoundedText(scope, locator);
    if (content === null) continue;
    const tokens = extractRootTokens(content);
    if (tokens.length === 0) continue;
    if (best === null || tokens.length > best.tokens.length) {
      best = { locator, tokens };
    }
  }

  const hasOwnTokens =
    best !== null && best.tokens.length >= MIN_PROJECT_DESIGN_TOKENS;
  if (!hasOwnTokens && walk.tailwindConfigLocator === null) return null;

  return Object.freeze({
    tokenSourceLocator: hasOwnTokens ? best!.locator : null,
    tokens: hasOwnTokens ? best!.tokens : Object.freeze([]),
    tailwindConfigLocator: walk.tailwindConfigLocator,
  });
}

// ---------------------------------------------------------------------------
// The derived contract document.
// ---------------------------------------------------------------------------

export interface ProjectDerivedDesignContractInput {
  /** Asserted only when `package.json` is the bound identity source. */
  readonly projectName: string | null;
  readonly probe: ProjectDesignSystemProbe;
  /** sha256 of the token source file, read at proposal time. */
  readonly tokenSourceHash: string | null;
  /** Workspace-relative locator that binds the project-name claim. */
  readonly boundSourceLocator: string;
}

const MAX_NAME_CHARS = 96;

function commentLine(value: string): string {
  return `<!-- ${sanitizeDesignCommentValue(value)} -->`;
}

function safeName(name: string | null): string | null {
  const trimmed = (name ?? '').trim().slice(0, MAX_NAME_CHARS);
  return /^[A-Za-z0-9@._/-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Rules for a project that already has a vocabulary. Deliberately different
 * from the house floor's rules: the instruction here is EXTEND, not adopt.
 *
 * No literal pixel/rem/hex value appears in this prose. The design sensor
 * extracts every token-shaped string from the contract and requires it to exist
 * in a style file, so a number invented in a sentence would fail the very
 * project it describes.
 */
const DERIVED_RULES_SECTION: readonly string[] = Object.freeze([
  '## Non-negotiable rules',
  '',
  '1. **Extend this vocabulary, never fork it.** A new colour, step, radius ' +
    'or duration is added to the token source above and consumed by name. A ' +
    'literal value written inline in a component is a defect.',
  "2. **This is the project's own identity, not a starting point to replace.** " +
    'Re-tokenizing the product into a different vocabulary is not a design ' +
    'task; it is a regression, and no mission is authorized to do it as a side ' +
    'effect of another goal.',
  '3. **Semantic HTML first.** Reach for `header`/`nav`/`main`/`section`/' +
    '`footer` and real controls before a `div` stack.',
  '4. **Every interactive element has designed `:hover`, `:focus-visible` and ' +
    '`:active` states.** A visible focus ring is not optional.',
  '5. **Contrast holds.** Text/background pairs clear WCAG AA, and interactive ' +
    'targets stay at least twenty-four by twenty-four CSS pixels.',
  '6. **Tokens are the floor, not the design.** A screen that only spends ' +
    'these values, with uniform spacing and no hierarchy, has not been ' +
    'designed. Raise it: scale contrast, deliberate rhythm, depth or layering, ' +
    'and colour used semantically rather than decoratively.',
]);

function tokenTable(
  tokens: readonly ProjectDesignToken[],
): readonly string[] {
  const shown = tokens.slice(0, MAX_CONTRACT_TOKENS);
  return [
    '| Token | Value |',
    '| --- | --- |',
    ...shown.map((token) => `| \`${token.name}\` | \`${token.value}\` |`),
    ...(tokens.length > shown.length
      ? [
          '',
          `Truncated at ${MAX_CONTRACT_TOKENS} tokens; the file named above ` +
            'remains the complete authority.',
        ]
      : []),
  ];
}

/**
 * Renders the contract for a project that already has a design system.
 *
 * Pure: no I/O, no clock. Same inputs, same bytes — which is what the
 * mechanical reviewer re-derives before approving.
 */
export function renderProjectDerivedDesignContract(
  input: ProjectDerivedDesignContractInput,
): string {
  const name = safeName(input.projectName);
  const { probe } = input;
  const source = probe.tokenSourceLocator;
  const heading = name ? `# Design contract — ${name}` : '# Design contract';
  const boundList = [
    `\`${input.boundSourceLocator}\``,
    ...(source ? [`\`${source}\``] : []),
    ...(probe.tailwindConfigLocator
      ? [`\`${probe.tailwindConfigLocator}\``]
      : []),
  ].join(' and ');

  return [
    commentLine(
      'DESIGN.md materialized by the Nexus context bootstrap autopilot',
    ),
    commentLine('contract-kind: nexus-project-derived-design-contract-v1'),
    commentLine('direction: project-own-design-system'),
    ...(source ? [commentLine(`direction-token-source: ${source}`)] : []),
    ...(source
      ? [
          commentLine(
            `direction-token-source-sha256: ${input.tokenSourceHash ?? 'unknown'}`,
          ),
        ]
      : []),
    ...(probe.tailwindConfigLocator
      ? [commentLine(`direction-tailwind-config: ${probe.tailwindConfigLocator}`)]
      : []),
    commentLine(`bound-source: ${input.boundSourceLocator}`),
    commentLine(DESIGN_ADAPTATION_NOTICE),
    '',
    heading,
    '',
    (name
      ? `Authority for every visual decision in \`${name}\`. `
      : 'Authority for every visual decision in this project. ') +
      `Bound to ${boundList}; nothing outside those files is asserted about ` +
      'this repository.',
    '',
    '**This project already has a design system, so Nexus did not issue one.** ' +
      'No house token floor and no third-party reference were imposed here: ' +
      (source
        ? `the tokens below were READ from \`${source}\`, which stays the ` +
          'single source of truth. This document exists so a mission can be ' +
          'held to the identity the product already has.'
        : `the Tailwind configuration at \`${probe.tailwindConfigLocator}\` ` +
          'stays the single source of truth. This document exists so a ' +
          'mission can be held to the identity the product already has.'),
    '',
    '## Visual direction',
    '',
    "The direction is the product's own. It was not chosen by a heuristic and " +
      'it was not copied from anyone: it was measured from the code in this ' +
      'repository. Read the file named above before generating any UI.',
    '',
    ...(source
      ? [
          `## Tokens in force — read from \`${source}\``,
          '',
          'These are the global custom properties this project already ' +
            'declares. Consume them by name.',
          '',
          ...tokenTable(probe.tokens),
        ]
      : [
          `## Tokens in force — \`${probe.tailwindConfigLocator}\``,
          '',
          'This project expresses its scale, palette and typography through ' +
            'its Tailwind configuration. Read that file and consume its scale ' +
            'by name; never hardcode a value beside it.',
        ]),
    ...(source && probe.tailwindConfigLocator
      ? [
          '',
          `A Tailwind configuration is also present at ` +
            `\`${probe.tailwindConfigLocator}\`; keep the two in agreement ` +
            'rather than introducing a third vocabulary.',
        ]
      : []),
    '',
    ...DERIVED_RULES_SECTION,
    '',
  ].join('\n');
}
