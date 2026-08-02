import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHouseDesignContract } from '../src/main/design/house-design-contract';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDir);
const sensorPaths = [
  path.join(repositoryRoot, 'scripts', 'design-system-sensor.mjs'),
  path.join(
    repositoryRoot,
    '.context',
    'nexus',
    'sensors',
    'design-system-sensor.mjs',
  ),
];
const fixtureRoots = [];

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-sensor-'));
  fixtureRoots.push(root);
  return root;
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function runSensor(sensorPath, cwd) {
  const result = spawnSync(process.execPath, [sensorPath], {
    cwd,
    encoding: 'utf8',
  });
  return {
    ...result,
    report: JSON.parse(result.stdout),
  };
}

/** Default sensor for the single-copy tests; the pair is covered explicitly. */
function run(cwd) {
  return runSensor(sensorPaths[0], cwd);
}

function messages(report) {
  return report.findings.map((finding) => finding.message).join('\n');
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The house contract, rendered for real and adopted for real.
// ---------------------------------------------------------------------------

function houseContract() {
  return renderHouseDesignContract({
    projectName: 'acme-console',
    choice: Object.freeze({
      mode: 'neutral',
      reason: 'empty-catalog',
      goalAxes: Object.freeze([]),
    }),
    catalogDir: '/home/operator/.design-references',
    kitContentHash: null,
    boundSourceLocator: 'package.json',
  });
}

/**
 * Reads the contract's token tables the way a human adopting the floor would:
 * first value of a token goes to `:root`, a later different value of the same
 * token is its dark-scheme value.
 *
 * Deliberately a SECOND implementation of the declaration rule, written from
 * the rule as prose rather than shared with the sensor: if the two drift, the
 * end-to-end test fails, which is the whole point of it.
 */
function adoptTokenFloor(markdown) {
  const light = new Map();
  const dark = new Map();
  for (const line of markdown.split('\n')) {
    const row = /^\|\s*`(--[a-z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|/i.exec(line);
    if (!row) continue;
    const [, token, value] = row;
    if (!light.has(token)) light.set(token, value);
    else if (light.get(token) !== value) dark.set(token, value);
  }
  const block = (entries, indent) =>
    [...entries].map(([t, v]) => `${indent}${t}: ${v};`).join('\n');
  return {
    css:
      `:root {\n${block(light, '  ')}\n}\n\n` +
      '@media (prefers-color-scheme: dark) {\n' +
      `  :root {\n${block(dark, '    ')}\n  }\n}\n`,
    tokenCount: light.size,
    documentedValues: light.size + dark.size,
  };
}

describe('house design contract passes the sensor that gates it', () => {
  it.each(sensorPaths)(
    'a project adopting the whole token floor verbatim exits 0 under %s',
    (sensorPath) => {
      const root = newRoot();
      const contract = houseContract();
      const adopted = adoptTokenFloor(contract);
      write(root, 'DESIGN.md', contract);
      write(root, 'src/styles/tokens.css', adopted.css);

      const result = runSensor(sensorPath, root);

      // The regression this whole rewrite exists for: `A 4px grid.` is prose
      // in the contract and the space scale is written in rem, so the old
      // sensor demanded a `4px` token that no table declares, and the merge
      // coordinator turned that exit 1 into a blocked merge.
      expect(messages(result.report)).not.toContain('4px');
      expect(result.status, result.stdout).toBe(0);
      expect(result.report).toMatchObject({ ok: true, findings: [], notes: [] });
      expect(result.report.designTokens).toBe(adopted.tokenCount);
      expect(result.report.designTokens).toBeGreaterThanOrEqual(30);
    },
  );

  it('declares both a light and a dark value for the theme tokens', () => {
    const adopted = adoptTokenFloor(houseContract());

    // Guards the test above against passing for a boring reason: if the dark
    // table ever stopped re-declaring the same tokens, "adoption" would be a
    // single flat block and the light/dark path would go unexercised.
    expect(adopted.documentedValues).toBeGreaterThan(adopted.tokenCount);
  });

  it('fails the moment one adopted value drifts from the contract', () => {
    const root = newRoot();
    const contract = houseContract();
    const adopted = adoptTokenFloor(contract);
    write(root, 'DESIGN.md', contract);
    write(
      root,
      'src/styles/tokens.css',
      adopted.css.replace('--color-accent: oklch(55% 0.13 250);', '--color-accent: red;'),
    );

    const result = run(root);

    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain('--color-accent');
    expect(messages(result.report)).toContain('oklch(55% 0.13 250)');
    expect(messages(result.report)).toContain('red');
  });
});

// ---------------------------------------------------------------------------
// Only declarations declare. Prose does not.
// ---------------------------------------------------------------------------

describe('token extraction reads declarations, never prose', () => {
  it('ignores measurements, colours and properties written in a sentence', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '# Design system',
        '',
        'A 4px grid. Body text sits at `0.8125rem` and the legacy accent was',
        '`#3dd9ff`; do not use `--legacy-accent: #3dd9ff` anywhere.',
        '',
        '- Bar height is `--bar-height: 44px` in the shell.',
        '',
        '| Token | Value |',
        '| --- | --- |',
        '| `--accent` | `#7c86ff` |',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --accent: #7c86ff; }\n');

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
    expect(result.report.designTokens).toBe(1);
    expect(result.report.designTokenSources).toEqual({
      tableRows: 1,
      cssFenceDeclarations: 0,
    });
  });

  it('reads a css code fence as declarations', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '# Design system',
        '',
        'Tokens:',
        '',
        '```css',
        ':root {',
        '  --accent: #7c86ff;',
        '  /* --ghost: #000; */',
        '}',
        '```',
        '',
        '```js',
        'const spacing = "--space-1: 4px";',
        '```',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --accent: #7c86ff; }\n');

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
    expect(result.report.designTokens).toBe(1);
    expect(result.report.designTokenSources.cssFenceDeclarations).toBe(1);
  });

  it('does not read a two-column glossary as documenting a value', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '# Design system',
        '',
        '| Token | Use |',
        '| --- | --- |',
        '| `--accent` | what is alive right now |',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --accent: #7c86ff; }\n');

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
    expect(result.report.designTokens).toBe(0);
    expect(result.report.notes.join('\n')).toContain('NOTHING');
  });
});

// ---------------------------------------------------------------------------
// The individual defects.
// ---------------------------------------------------------------------------

describe('what the sensor verifies about a declared token', () => {
  it('a CSS comment cannot satisfy the gate', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      ['| Token | Value |', '| --- | --- |', '| `--accent` | `#7c86ff` |', ''].join('\n'),
    );
    write(
      root,
      'app.css',
      ['/* --accent: #7c86ff; */', '/* grid: 4px */', '.x { color: blue; }', ''].join('\n'),
    );

    const result = run(root);

    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain(
      'declares 1 token(s) that no style file declares: --accent',
    );
  });

  it('a line comment cannot satisfy the gate in dialects that have one', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      ['| Token | Value |', '| --- | --- |', '| `--accent` | `#7c86ff` |', ''].join('\n'),
    );
    write(root, 'app.scss', '// --accent: #7c86ff;\n.x { color: blue; }\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain('--accent');
  });

  it('verifies colour values, oklch included', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '| Token | Value |',
        '| --- | --- |',
        '| `--color-canvas` | `oklch(99% 0 0)` |',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --color-canvas: red; }\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.report.findings[0].severity).toBe('high');
    expect(messages(result.report)).toContain('oklch(99% 0 0)');
    expect(messages(result.report)).toContain('red (app.css)');
  });

  it('keeps decimals intact in both the comparison and the message', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '| Token | Value |',
        '| --- | --- |',
        '| `--text-caption` | `clamp(0.75rem, 0.72rem + 0.15vw, 0.8125rem)` |',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --text-caption: 1rem; }\n');

    const result = run(root);

    expect(result.status).toBe(1);
    // The old word-boundary regex reported phantom tokens (`75rem`,
    // `9375rem`, `8125rem`) that appear nowhere in the document. `\b` cannot
    // express that assertion — it matches INSIDE `0.8125rem`, which is the
    // very mutilation under test — so the fragment must be pinned as one that
    // is not preceded by the digits it was cut from.
    expect(messages(result.report)).toContain('0.8125rem');
    expect(messages(result.report)).not.toMatch(/(?<![\d.])8125rem/);
    expect(messages(result.report)).not.toMatch(/(?<![\d.])75rem/);
  });

  it('treats comma spacing and quoting as insignificant, and nothing else', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '| Token | Value |',
        '| --- | --- |',
        '| `--font-sans` | `system-ui, -apple-system, "Segoe UI", sans-serif` |',
        '| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |',
        '',
      ].join('\n'),
    );
    write(
      root,
      'app.css',
      ':root {\n' +
        "  --font-sans: system-ui,-apple-system,'Segoe UI',sans-serif;\n" +
        '  --ease-standard: cubic-bezier(0.2,0,0,1);\n' +
        '}\n',
    );

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
    expect(result.report.findings).toEqual([]);
  });

  it('accepts a token declared under a dark scheme block, not only in :root', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '| Token | Value |',
        '| --- | --- |',
        '| `--canvas` | `oklch(99% 0 0)` |',
        '| `--canvas` | `oklch(17% 0 0)` |',
        '',
      ].join('\n'),
    );
    write(
      root,
      'app.css',
      ':root { --canvas: oklch(99% 0 0); }\n' +
        '@media (prefers-color-scheme: dark) { :root { --canvas: oklch(17% 0 0); } }\n',
    );

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
  });

  it('flags a documented value the code never declares, even with other values present', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      [
        '| Token | Value |',
        '| --- | --- |',
        '| `--canvas` | `oklch(99% 0 0)` |',
        '| `--canvas` | `oklch(17% 0 0)` |',
        '',
      ].join('\n'),
    );
    write(root, 'app.css', ':root { --canvas: oklch(99% 0 0); }\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain('oklch(17% 0 0)');
  });
});

// ---------------------------------------------------------------------------
// Drift detection belongs to every project, not to a hardcoded Nexus path.
// ---------------------------------------------------------------------------

describe('drift detection is portable', () => {
  it('catches a contradiction in a style file of any name or depth', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      ['| Token | Value |', '| --- | --- |', '| `--accent` | `#7c86ff` |', ''].join('\n'),
    );
    // Not src/renderer/styles/base.css: that path only exists in the Nexus
    // repository, and the sensor is copied into arbitrary user workspaces.
    write(root, 'packages/ui/src/theme/palette.css', ':root { --accent: #3dd9ff; }\n');

    const result = run(root);

    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain(
      'packages/ui/src/theme/palette.css',
    );
    expect(result.report.findings[0].severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// When it cannot measure, it says so instead of reporting a pass as evidence.
// ---------------------------------------------------------------------------

describe('honest silence', () => {
  it('states that nothing was verified when the project has no style file', () => {
    const root = newRoot();
    write(
      root,
      'DESIGN.md',
      ['| Token | Value |', '| --- | --- |', '| `--accent` | `#7c86ff` |', ''].join('\n'),
    );
    write(root, 'server.ts', 'export const port = 3000;\n');

    const result = run(root);

    expect(result.status, result.stdout).toBe(0);
    expect(result.report.findings).toEqual([]);
    expect(result.report.styleFiles).toBe(0);
    expect(result.report.notes.join('\n')).toContain('NOTHING was');
  });

  it('still fails a missing or empty DESIGN.md', () => {
    const empty = newRoot();
    expect(run(empty).status).toBe(1);

    const blank = newRoot();
    write(blank, 'DESIGN.md', '   \n');
    const result = run(blank);
    expect(result.status).toBe(1);
    expect(messages(result.report)).toContain('is empty');
  });
});

// ---------------------------------------------------------------------------
// Deployment invariants.
// ---------------------------------------------------------------------------

describe('design system sensor recursive style discovery', () => {
  it.each(sensorPaths)(
    'matches root and deeply nested CSS through **/ in %s',
    (sensorPath) => {
      const root = newRoot();
      write(
        root,
        'DESIGN.md',
        [
          '# Design system',
          '',
          '| Token | Value | Use |',
          '| --- | --- | --- |',
          '| `--accent` | `#123456` | accent |',
          '| `--gap` | `12px` | grid gap |',
          '| `--radius` | `0.25rem` | corners |',
          '',
        ].join('\n'),
      );
      write(root, 'root.css', ':root { --accent: #123456; --gap: 12px; }\n');
      write(
        root,
        'src/theme/nested/component.css',
        ':root { --radius: 0.25rem; }\n.component { color: var(--accent); }\n',
      );

      const result = runSensor(sensorPath, root);

      expect(result.status, result.stderr).toBe(0);
      expect(result.report).toMatchObject({
        ok: true,
        designTokens: 3,
        styleFiles: 2,
        findings: [],
      });
    },
  );

  it('keeps the bundled workspace sensor byte-identical to its source', () => {
    expect(fs.readFileSync(sensorPaths[1], 'utf8')).toBe(
      fs.readFileSync(sensorPaths[0], 'utf8'),
    );
  });
});
