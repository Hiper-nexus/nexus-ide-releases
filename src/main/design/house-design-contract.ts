import {
  DESIGN_ADAPTATION_NOTICE,
  sanitizeDesignCommentValue,
} from './design-kit-source';
import type { DesignDirectionChoice } from './design-kit-selection';

/**
 * The contract Nexus writes with its OWN hands.
 *
 * Why the body is house-authored instead of a copied kit
 * -----------------------------------------------------
 * A context draft may only bind sources that live inside the workspace and
 * hash (see `verifySources` in context-knowledge-service). A design kit lives
 * in `~/.design-references` or in an npx catalog — outside every workspace —
 * so its bytes can never be honestly attested as project authority. Pasting
 * them anyway would put third-party prose into a document whose attestation
 * claims `package.json` as its evidence. That is a provenance lie, and it is
 * also the exact thing the dembrandt rule forbids: copying a brand.
 *
 * So the kit never enters the contract. What enters is:
 *   - its ID and the sha256 of the file that was read (identifiers and a
 *     binding, not content);
 *   - HOW it was chosen (pinned setting / matched axes + confidence / none);
 *   - an instruction to READ that file before generating UI and ADAPT it.
 *
 * Everything else — the token floor below — is Nexus's own product template.
 * It asserts nothing about the repository except the project name, which is
 * bound to `package.json`. That is what makes the whole document verifiable
 * by byte-exact re-derivation instead of by an opinion.
 *
 * Why the tokens are boring on purpose
 * ------------------------------------
 * This is a FLOOR, not a look. Its job is to stop a mission from inventing
 * six different greys at 2am; it is not the design. The contract says so out
 * loud, because a neutral baseline that nobody raises is exactly the "made by
 * an AI" surface this whole path exists to prevent.
 *
 * Pure: no I/O, no clock. Same inputs, same bytes.
 */

export interface HouseDesignContractInput {
  /** Asserted only when `package.json` is the bound source; null otherwise. */
  readonly projectName: string | null;
  readonly choice: DesignDirectionChoice;
  /**
   * Catalog dir, echoed so the reader can find the reference. It must already
   * be HOME-RELATIVE (`~/.design-references`): this document is applied and
   * committed, so an absolute path would carry the operator's OS account name
   * into the repository history and into every clone. See `homeRelativePath`.
   */
  readonly catalogDir: string;
  /** sha256 of the referenced kit file, read at proposal time. */
  readonly kitContentHash: string | null;
  /** Workspace-relative locator that binds the project-name claim. */
  readonly boundSourceLocator: string;
}

const MAX_NAME_CHARS = 96;

function commentLine(value: string): string {
  return `<!-- ${sanitizeDesignCommentValue(value)} -->`;
}

/**
 * Kit titles, file names and the catalog directory are operator- and
 * third-party-controlled strings that land in Markdown PROSE. The shared
 * `sanitizeDesignCommentValue` is the right guard inside `<!-- ... -->` (it
 * kills the closer), but prose needs the opposite guard: a kit whose title
 * contains `<!--` would comment out the entire token floor and rule list for
 * any renderer, hiding the contract from the agent that must obey it.
 * Backticks get the same treatment so a title cannot escape its code span.
 */
function safeInline(value: string): string {
  return sanitizeDesignCommentValue(value)
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeName(name: string | null): string | null {
  const trimmed = (name ?? '').trim().slice(0, MAX_NAME_CHARS);
  // The name lands in a Markdown heading and in an HTML comment; keep it to
  // characters that cannot restructure either.
  return /^[A-Za-z0-9@._/-]+$/.test(trimmed) ? trimmed : null;
}

function directionMarkerLines(input: HouseDesignContractInput): string[] {
  const { choice } = input;
  if (choice.mode === 'neutral') {
    return [
      'direction: neutral-house-baseline',
      `direction-reason: ${choice.reason}`,
    ];
  }
  const shared =
    choice.mode === 'match' ? choice.sharedAxes.join(',') || 'none' : 'n/a';
  return [
    `direction: ${choice.mode === 'setting' ? 'pinned-setting' : 'signal-match'}`,
    `direction-kit: ${choice.kit.kitId} (${choice.kit.sourceId})`,
    `direction-kit-file: ${input.catalogDir}/${choice.kit.locator}`,
    `direction-kit-sha256: ${input.kitContentHash ?? 'unknown'}`,
    ...(choice.mode === 'match'
      ? [
          `direction-matched-axes: ${shared}`,
          `direction-confidence: ${choice.confidence}`,
        ]
      : ['direction-confidence: explicit (orch.designDefaultKit)']),
  ];
}

const NEUTRAL_REASON_PROSE: Readonly<
  Record<
    Extract<DesignDirectionChoice, { mode: 'neutral' }>['reason'],
    string
  >
> = Object.freeze({
  'empty-catalog':
    'the local design reference catalog is empty or absent, so there was no ' +
    'reference to choose from',
  'pinned-kit-unavailable':
    '`orch.designDefaultKit` names a kit this catalog does not have. Nexus ' +
    'refuses to substitute a different brand for the one a human pinned',
  'no-domain-signal':
    'the goal names no product domain that any catalogued reference also ' +
    'claims, so no direction is proven',
  'ambiguous-match':
    'two or more references matched the goal equally well. A tie is not a ' +
    'direction, and picking one of them would be picking a brand at random',
});

function directionSection(input: HouseDesignContractInput): string[] {
  const { choice } = input;
  if (choice.mode === 'neutral') {
    return [
      '## Visual direction — NONE CHOSEN (neutral house baseline)',
      '',
      `This contract is **neutral**: ${NEUTRAL_REASON_PROSE[choice.reason]}.`,
      '',
      'No third-party design system informs this document. The tokens below ' +
        'are Nexus house defaults, not a measured brand.',
      '',
      '**Before building UI, establish a direction.** Pin one with ' +
        '`orch.designDefaultKit`, or state the intended direction in the ' +
        'mission goal, or decide one here and rewrite this section. Shipping ' +
        'the floor below untouched produces exactly the anonymous, ' +
        'machine-made surface this contract exists to prevent.',
    ];
  }

  const how =
    choice.mode === 'setting'
      ? [
          'Chosen by **explicit operator setting** (`orch.designDefaultKit`). ' +
            'This is a human decision and outranks every heuristic.',
        ]
      : [
          'Chosen by **signal match**, not by a human: the goal and this ' +
            `reference share the product-domain axes ` +
            `\`${choice.sharedAxes.join('`, `') || 'none'}\`, and no other ` +
            `catalogued reference matched as well (next-best score ` +
            `${choice.runnerUpScore}).`,
          '',
          `Confidence: **${choice.confidence}**.` +
            (choice.confidence === 'low'
              ? ' A single shared axis decided this. Confirm the direction ' +
                'before it hardens into the product — pin it with ' +
                '`orch.designDefaultKit` if it is right, replace this section ' +
                'if it is not.'
              : ''),
        ];

  return [
    '## Visual direction',
    '',
    `Reference: \`${choice.kit.kitId}\` — ${safeInline(choice.kit.title)}`,
    '',
    `Reference file: \`${safeInline(`${input.catalogDir}/${choice.kit.locator}`)}\`` +
      (input.kitContentHash ? ` (sha256 \`${input.kitContentHash}\`)` : ''),
    '',
    ...how,
    '',
    '**How to use it.** Read that file before generating any UI, and ADAPT ' +
      'its composition, rhythm and motion decisions to this product. Its ' +
      'palette, type stack, logo and wordmark belong to someone else: they ' +
      'are deliberately absent from this document and must never be copied ' +
      'into the code. The tokens below stay in force until this project ' +
      'derives its own from that reading.',
  ];
}

/** Conservative floor. Deliberately unremarkable; deliberately complete. */
const TOKEN_SECTION: readonly string[] = Object.freeze([
  '## Token floor',
  '',
  'Declare these as CSS custom properties on `:root` and consume them by ' +
    'name. A hardcoded colour, radius or duration anywhere in the UI is a ' +
    'defect, not a shortcut.',
  '',
  '### Colour — light',
  '',
  '| Token | Value | Use |',
  '| --- | --- | --- |',
  '| `--color-canvas` | `oklch(99% 0 0)` | page background |',
  '| `--color-surface` | `oklch(97% 0 0)` | raised panels, cards |',
  '| `--color-hairline` | `oklch(90% 0 0)` | 1px separators, borders |',
  '| `--color-ink` | `oklch(21% 0 0)` | primary text |',
  '| `--color-ink-muted` | `oklch(52% 0 0)` | secondary text, captions |',
  '| `--color-accent` | `oklch(55% 0.13 250)` | the single interactive accent |',
  '| `--color-accent-ink` | `oklch(99% 0 0)` | text/icons on the accent |',
  '| `--color-danger` | `oklch(55% 0.18 25)` | destructive actions only |',
  '',
  '### Colour — dark',
  '',
  '| Token | Value | Use |',
  '| --- | --- | --- |',
  '| `--color-canvas` | `oklch(17% 0 0)` | page background |',
  '| `--color-surface` | `oklch(22% 0 0)` | raised panels, cards |',
  '| `--color-hairline` | `oklch(32% 0 0)` | 1px separators, borders |',
  '| `--color-ink` | `oklch(96% 0 0)` | primary text |',
  '| `--color-ink-muted` | `oklch(70% 0 0)` | secondary text, captions |',
  '| `--color-accent` | `oklch(70% 0.13 250)` | the single interactive accent |',
  '| `--color-accent-ink` | `oklch(17% 0 0)` | text/icons on the accent |',
  '| `--color-danger` | `oklch(68% 0.17 25)` | destructive actions only |',
  '',
  'The dark table re-declares the same token NAMES under a dark condition ' +
    '(`@media (prefers-color-scheme: dark)`, or a theme attribute) — it is ' +
    'not a second set of names. Both values have to exist in the code, and ' +
    'this document is the authority they are checked against: the moment a ' +
    'value here stops matching the code, correct whichever side moved.',
  '',
  'One accent. A second decorative hue must be justified in this document ' +
    'before it appears in code. Every text/background pair above clears ' +
    'WCAG AA at body size; keep it that way when the accent changes.',
  '',
  '### Type',
  '',
  '| Token | Value |',
  '| --- | --- |',
  '| `--font-sans` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |',
  '| `--font-mono` | `ui-monospace, SFMono-Regular, "JetBrains Mono", monospace` |',
  '| `--text-caption` | `clamp(0.75rem, 0.72rem + 0.15vw, 0.8125rem)` |',
  '| `--text-body` | `clamp(0.9375rem, 0.9rem + 0.2vw, 1rem)` |',
  '| `--text-title` | `clamp(1.25rem, 1.1rem + 0.75vw, 1.75rem)` |',
  '| `--text-display` | `clamp(2rem, 1.4rem + 3vw, 3.5rem)` |',
  '',
  'Two families at most. Hierarchy comes from scale and weight contrast, not ' +
    'from a third typeface.',
  '',
  '### Space, radius, elevation',
  '',
  '| Token | Value |',
  '| --- | --- |',
  '| `--space-1` | `0.25rem` |',
  '| `--space-2` | `0.5rem` |',
  '| `--space-3` | `0.75rem` |',
  '| `--space-4` | `1rem` |',
  '| `--space-6` | `1.5rem` |',
  '| `--space-8` | `2rem` |',
  '| `--space-12` | `3rem` |',
  '| `--space-section` | `clamp(3rem, 2rem + 5vw, 7rem)` |',
  '| `--radius-sm` | `0.25rem` |',
  '| `--radius-md` | `0.5rem` |',
  '| `--radius-lg` | `0.875rem` |',
  '| `--shadow-raised` | `0 1px 2px oklch(0% 0 0 / 0.06), 0 8px 24px oklch(0% 0 0 / 0.08)` |',
  '',
  'A 4px grid. Uniform padding everywhere is not rhythm — vary it with ' +
    'intent, but only in these steps.',
  '',
  '### Motion',
  '',
  '| Token | Value |',
  '| --- | --- |',
  '| `--duration-fast` | `120ms` |',
  '| `--duration-normal` | `220ms` |',
  '| `--duration-slow` | `420ms` |',
  '| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |',
  '| `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` |',
  '',
  'Animate `transform`, `opacity`, `clip-path` and `filter` only. Every ' +
    'motion must be disabled under `prefers-reduced-motion: reduce`.',
]);

const RULES_SECTION: readonly string[] = Object.freeze([
  '## Non-negotiable rules',
  '',
  '1. **Adapt, never copy.** Tokens above and any reference named here are a ' +
    "starting point for THIS project's identity. Never reproduce a " +
    "third-party brand, logo, wordmark or proprietary typeface.",
  '2. **Semantic HTML first.** Reach for `header`/`nav`/`main`/`section`/' +
    '`footer` and real controls before a `div` stack.',
  '3. **Every interactive element has designed `:hover`, `:focus-visible` and ' +
    '`:active` states.** A visible focus ring is not optional.',
  '4. **No hardcoded values.** Colour, spacing, radius, duration and type ' +
    'size come from the tokens above.',
  '5. **Contrast holds.** Text/background pairs clear WCAG AA; interactive ' +
    'targets are at least 24x24 CSS px.',
  '6. **The floor is not the design.** A screen that uses only the values ' +
    'above, with uniform spacing and no hierarchy, has not been designed. ' +
    'Raise it: scale contrast, deliberate rhythm, depth or layering, and ' +
    'colour used semantically rather than decoratively.',
]);

export function renderHouseDesignContract(
  input: HouseDesignContractInput,
): string {
  const name = safeName(input.projectName);
  const heading = name ? `# Design contract — ${name}` : '# Design contract';
  return [
    commentLine(
      'DESIGN.md materialized by the Nexus context bootstrap autopilot',
    ),
    commentLine('contract-kind: nexus-house-design-contract-v1'),
    ...directionMarkerLines(input).map(commentLine),
    commentLine(`bound-source: ${input.boundSourceLocator}`),
    commentLine(DESIGN_ADAPTATION_NOTICE),
    '',
    heading,
    '',
    name
      ? `Authority for every visual decision in \`${name}\`. Bound to ` +
        `\`${input.boundSourceLocator}\`; nothing outside that file is ` +
        'asserted about this repository.'
      : 'Authority for every visual decision in this project. Bound to ' +
        `\`${input.boundSourceLocator}\`; nothing outside that file is ` +
        'asserted about this repository.',
    '',
    'Nexus wrote this document from its own house template so that a UI ' +
      'mission never starts without a contract. It is not measured from any ' +
      'third-party brand.',
    '',
    ...directionSection(input),
    '',
    ...TOKEN_SECTION,
    '',
    ...RULES_SECTION,
    '',
  ].join('\n');
}
