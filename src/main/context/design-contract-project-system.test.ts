import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildDesignContractBootstrap } from './design-contract-bootstrap';
import { MIN_PROJECT_DESIGN_TOKENS } from '../design/project-design-system';

/**
 * H5 — A MATURE PROJECT MUST NOT INHERIT A PERMANENTLY RED SENSOR.
 *
 * Reproduced before the fix: a repository with its own CSS and its own identity
 * but no DESIGN.md received the neutral HOUSE floor. `design-system-sensor.mjs`
 * then re-read that contract and demanded every token in it appear in a style
 * file, producing `spacing tokens ... not found: 1px, 75rem` and
 * `custom-property tokens ... not found: --color-canvas, --color-surface`,
 * EXIT=1, forever — for a mission that asked to change one colour.
 *
 * The tests below encode the chosen policy (DERIVE, do not impose) and, more
 * importantly, the SENSOR INVARIANT: this file re-implements the sensor's own
 * extraction and asserts that nothing the contract declares can fail to be
 * found in the style files. That is the property that makes the red impossible
 * rather than merely unlikely.
 */

let root: string;
let catalogDir: string;
let scope: ProjectExecutionScope;

const UI_GOAL = 'redesign da interface do dashboard de metricas';

/** A repository with an identity of its own, expressed as global tokens. */
const PROJECT_TOKENS_CSS = `
/* the product's own vocabulary, nothing like the house floor */
:root {
  --brand-ink: #10233f;
  --brand-paper: #fbf7ef;
  --brand-signal: rgb(214, 92, 39);
  --brand-hairline: #d9d1c4;
  --brand-muted: #6d6459;
  --step-1: 6px;
  --step-2: 12px;
  --step-3: 18px;
  --corner: 3px;
  --pace: 90ms;
}

:root[data-theme='dark'] {
  --brand-ink: #fbf7ef;
}

.card { background: var(--brand-paper); }
`;

function writeProjectStyles(relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

/**
 * The design sensor's own token extraction, copied verbatim in behaviour from
 * `scripts/design-system-sensor.mjs`. Kept here rather than imported so this
 * test states the CONTRACT the sensor enforces, and fails loudly if the two
 * ever drift apart.
 */
const SENSOR_TOKEN_PATTERNS: readonly {
  readonly kind: string;
  readonly regex: RegExp;
}[] = [
  { kind: 'color', regex: /#[a-f0-9]{3,8}\b/gi },
  { kind: 'color', regex: /rgb\([^)]+\)/gi },
  { kind: 'color', regex: /rgba\([^)]+\)/gi },
  { kind: 'color', regex: /hsl\([^)]+\)/gi },
  { kind: 'font', regex: /font-family[:\s]+([^;\n]+)/gi },
  { kind: 'spacing', regex: /\b(\d+px|\d+rem|\d+em)\b/gi },
  { kind: 'custom-property', regex: /--[a-z0-9](?:[a-z0-9_-]+)?/gi },
];

function sensorTokens(content: string): string[] {
  const tokens: string[] = [];
  for (const { kind, regex } of SENSOR_TOKEN_PATTERNS) {
    for (const match of content.matchAll(regex)) {
      const raw = match[1] ?? match[0];
      const normalized = raw.trim().replace(/['"]/g, '').toLowerCase();
      if (normalized) tokens.push(`${kind}:${normalized}`);
    }
  }
  return tokens;
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-derived-')),
  );
  catalogDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-derived-kits-')),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'acme-console' }, null, 2)}\n`,
    'utf8',
  );
  scope = testProjectScope({ rootRealPath: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(catalogDir, { recursive: true, force: true });
});

describe('a project that already has a design system', () => {
  it('gets a contract DERIVED from its own tokens, not the house floor', async () => {
    writeProjectStyles('src/styles/base.css', PROJECT_TOKENS_CSS);

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.skipReason).toBeNull();
    expect(decision.contractKind).toBe('project-derived');
    const content = decision.proposal?.content ?? '';
    expect(content).toContain(
      '<!-- contract-kind: nexus-project-derived-design-contract-v1 -->',
    );
    // The project's real vocabulary is what the contract declares.
    expect(content).toContain('| `--brand-ink` | `#10233f` |');
    expect(content).toContain('| `--step-2` | `12px` |');
    // And NOT one token of the house floor, which is what turned the sensor red.
    expect(content).not.toContain('--color-canvas');
    expect(content).not.toContain('--space-section');
    expect(content).not.toContain('## Token floor');
  });

  it('never proposes a third-party brand to a project that has its own', async () => {
    writeProjectStyles('src/styles/base.css', PROJECT_TOKENS_CSS);
    fs.writeFileSync(
      path.join(catalogDir, 'panelkit.md'),
      '---\nname: panelkit\ndescription: "A dense dashboard and analytics system with metrics and charts."\n---\n\n# panelkit\n',
      'utf8',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.choice).toBeNull();
    expect(decision.proposal?.content ?? '').not.toContain('panelkit');
  });

  it('satisfies the design sensor BY CONSTRUCTION', async () => {
    writeProjectStyles('src/styles/base.css', PROJECT_TOKENS_CSS);

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    const contract = decision.proposal?.content ?? '';
    const styleTokens = new Set(sensorTokens(PROJECT_TOKENS_CSS));
    const untokenized = sensorTokens(contract).filter(
      (token) => !styleTokens.has(token),
    );
    // This is the whole point of H5: the sensor's `untokenized` list must be
    // empty, so a project that changes one colour is never asked to
    // re-tokenize the entire application.
    expect(untokenized).toEqual([]);
  });

  it('binds the token file as evidence so the contract cannot outlive it', async () => {
    writeProjectStyles('src/styles/base.css', PROJECT_TOKENS_CSS);

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.proposal?.sources.map((s) => s.locator)).toEqual([
      'package.json',
      'src/styles/base.css',
    ]);
    for (const source of decision.proposal?.sources ?? []) {
      expect(source.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // Editing the tokens changes the contract, which is what makes a stale
    // draft fail the mechanical re-derivation instead of being applied.
    writeProjectStyles(
      'src/styles/base.css',
      PROJECT_TOKENS_CSS.replace('#10233f', '#101f3a'),
    );
    const after = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });
    expect(after.proposal?.content).not.toBe(decision.proposal?.content);
  });

  it('is byte-deterministic, which the mechanical reviewer re-derives', async () => {
    writeProjectStyles('src/styles/base.css', PROJECT_TOKENS_CSS);
    writeProjectStyles('src/components/card.css', ':root { --local: 4px; }');

    const first = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });
    const second = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });
    expect(second.proposal?.content).toBe(first.proposal?.content);
    // One file wins — the richest `:root` — so two files can never contribute
    // two values for the same token name.
    expect(second.proposal?.sources.map((s) => s.locator)).toEqual([
      'package.json',
      'src/styles/base.css',
    ]);
  });

  it('falls back to the house floor when there is no vocabulary to derive', async () => {
    // A handful of stray variables is a component, not a design system.
    writeProjectStyles('src/a.css', ':root { --x: 1px; --y: 2px; }');

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(MIN_PROJECT_DESIGN_TOKENS).toBeGreaterThan(2);
    expect(decision.contractKind).toBe('house-floor');
    expect(decision.proposal?.content).toContain('## Token floor');
  });

  it('treats a Tailwind configuration as the project speaking for itself', async () => {
    fs.writeFileSync(
      path.join(root, 'tailwind.config.ts'),
      'export default { theme: { extend: {} } };\n',
      'utf8',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.contractKind).toBe('project-derived');
    const content = decision.proposal?.content ?? '';
    expect(content).toContain('tailwind.config.ts');
    expect(content).not.toContain('## Token floor');
  });

  it('drops a token whose value could restructure the document', async () => {
    writeProjectStyles(
      'src/styles/base.css',
      PROJECT_TOKENS_CSS.replace(
        '--corner: 3px;',
        "--corner: 3px; --evil: a|b<!-- x -->;",
      ),
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    const content = decision.proposal?.content ?? '';
    // Dropped, not escaped: escaping would put a value in the document that no
    // style file contains, and the sensor would then fail the project for it.
    expect(content).not.toContain('--evil');
    expect(content.match(/<!--/g)?.length).toBe(content.match(/-->/g)?.length);
  });
});

describe('the committed contract never carries the operator identity', () => {
  it('renders the reference catalog home-relative, not as an absolute path', async () => {
    const home = os.homedir();
    const homeCatalog = fs.mkdtempSync(
      path.join(home, '.nexus-design-catalog-test-'),
    );
    try {
      fs.writeFileSync(
        path.join(homeCatalog, 'panelkit.md'),
        '---\nname: panelkit\ndescription: "A dense dashboard and analytics system with metrics and charts."\n---\n\n# panelkit\n',
        'utf8',
      );

      const decision = await buildDesignContractBootstrap({
        scope,
        goal: UI_GOAL,
        catalogDir: homeCatalog,
      });

      const content = decision.proposal?.content ?? '';
      expect(decision.choice?.mode).toBe('match');
      // The document is applied and COMMITTED: an absolute path would put the
      // OS account name into the repository history and into every clone.
      expect(content).toContain('~/');
      expect(content).not.toContain(home);
      expect(content).not.toContain(path.basename(home));
      expect(content).not.toContain('/Users/');
      expect(content).not.toContain('/home/');
    } finally {
      fs.rmSync(homeCatalog, { recursive: true, force: true });
    }
  });
});
