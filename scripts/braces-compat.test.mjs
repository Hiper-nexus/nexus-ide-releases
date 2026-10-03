import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatRoot = path.join(root, 'third_party', 'braces-compat');
const packageJson = require(path.join(root, 'package.json'));
const packageLock = require(path.join(root, 'package-lock.json'));
const provenance = require(
  path.join(root, 'third_party', 'provenance', 'braces-3.0.3-compat.json'),
);

const MAX_DEPTH = 512;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Rebuilds the upstream braces 3.0.3 `lib/parse.js` by removing exactly the
 * Nexus hunk. The caller proves the result is byte-identical to the npm
 * tarball, so the patch is provably nothing more than this hunk.
 */
function upstreamParseSource() {
  const patched = fs.readFileSync(path.join(compatRoot, 'lib', 'parse.js'), 'utf8');
  const start = patched.indexOf('/**\n * Nexus security patch');
  const end = patched.indexOf('/**\n * parse\n */');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const call = '      assertDepth(stack.length);\n';
  const withoutBlock = patched.slice(0, start) + patched.slice(end);
  expect(withoutBlock.split(call)).toHaveLength(3);
  return withoutBlock.split(call).join('');
}

/**
 * Materializes the untouched braces 3.0.3 package (hash-verified against the
 * provenance ledger) in a temp dir, to serve as the differential oracle and
 * as the positive control that the attack input really crashes upstream.
 */
function materializeUpstreamBraces() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-braces-3.0.3-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const file of provenance.files) {
    if (file.originalPath === 'LICENSE') continue;
    const content =
      file.type === 'patched'
        ? upstreamParseSource()
        : fs.readFileSync(path.join(root, file.nexusPath), 'utf8');
    expect(sha256(content), file.originalPath).toBe(file.originalSha256);
    fs.writeFileSync(path.join(dir, file.originalPath), content);
  }
  const fillRange = path.dirname(
    require.resolve('fill-range/package.json', { paths: [compatRoot] }),
  );
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(
    fillRange,
    path.join(dir, 'node_modules', 'fill-range'),
    'junction',
  );
  return dir;
}

function nested(open, close, depth, middle = 'a') {
  return open.repeat(depth) + middle + close.repeat(depth);
}

/**
 * Runs every string entrypoint (compile through braces(), expand, stringify)
 * over deeply nested patterns in a child process, so a stack overflow or hang
 * fails the assertion instead of the vitest worker.
 */
function attackInChild(entrypoint, depth, nodeArgs = []) {
  const script = `
    const braces = require(${JSON.stringify(entrypoint)});
    const depth = ${depth};
    const shapes = {
      braces: '{'.repeat(depth) + 'a' + '}'.repeat(depth),
      parens: '('.repeat(depth) + 'a' + ')'.repeat(depth),
      unclosed: '{'.repeat(depth) + 'a',
    };
    const results = {};
    const log = console.log;
    console.log = () => {};
    for (const [shape, pattern] of Object.entries(shapes)) {
      for (const [mode, run] of Object.entries({
        compile: () => braces(pattern),
        expand: () => braces(pattern, { expand: true }),
        stringify: () => braces.stringify(pattern),
      })) {
        const started = process.hrtime.bigint();
        try {
          run();
          results[shape + '.' + mode] = { outcome: 'ok' };
        } catch (error) {
          results[shape + '.' + mode] = {
            outcome: error.constructor.name,
            message: String(error.message),
          };
        }
        results[shape + '.' + mode].ms =
          Number(process.hrtime.bigint() - started) / 1e6;
      }
    }
    console.log = log;
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, [...nodeArgs, '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1_024 * 1_024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

// Real glob shapes from the Forge/Vite toolchain and the Nexus tree, plus
// the edge cases the braces parser treats specially (escapes, quotes,
// ranges, invalid/unbalanced sets, extglob-like parentheses, `$`).
const CORPUS = [
  'src/**/*.{ts,tsx}',
  '{src,scripts}/**/*.{ts,mjs}',
  '**/*.{js,cjs,mjs}',
  '**/.bin/**/*',
  '**/node_modules/**',
  'node_modules/{@electron,@electron-forge}/**/*.js',
  'resources/{darwin,linux,win32}/**',
  'out/make/**/*.{dmg,zip,deb,rpm,exe,nupkg}',
  'build/**/*.{js,map}',
  '*.{png,jpg,jpeg,gif,svg,webp}',
  'a/{b,c}/d',
  'a/{b,c}/{d,e}/{f,g}',
  '{a,b}{c,d}{e,f}',
  '{x,y}{1,2}{a,b}',
  'x{,y}',
  '{,a}',
  '{a,}',
  '{a}',
  '{a,{b,c}}',
  '{{a,b},{c,d}}',
  'a{b{c,d},e}f',
  '{{{a,b},c},d}',
  'file-{1..10}.txt',
  '{a..e}',
  '{A..F}',
  'v{01..10..2}',
  '{0001..0003}',
  '{-2..2}',
  '{a..z..5}',
  '{1..3}{a..c}',
  'x/{1..3}/{a..b}',
  '{1..20}',
  '{1..ff}',
  '\\{a,b\\}',
  '{a,b}\\,c',
  'a/\\{b,c}/d',
  "'{a,b}'",
  '"{a,b}"',
  '`{a,b}`',
  '${a,b}',
  'a/{}/b',
  '{}',
  '{{}}',
  '{a,b',
  'a,b}',
  '}{',
  '{a,b}}',
  '[a-z]{1,2}',
  '[{]x',
  '[[:alpha:]]{a,b}',
  '!(*.d).ts',
  '+(a|b)',
  '@(foo|bar).js',
  '(a|b)',
  '((a))',
  'a(b{c,d})e',
  '{(a|b),c}',
  '**/{a,b}/**/*.md',
  'foo/{a,b}*',
  '{.,}**/*.json',
  'C:\\\\{a,b}',
  'a/{b,c}/{1..3}',
];

const OPTION_SETS = [
  {},
  { expand: true },
  // fast-glob's micromatch.braces call for brace expansion.
  { expand: true, nodupes: true, keepEscaping: true },
  { expand: true, noempty: true },
  { keepQuotes: true },
  { keepEscaping: true },
  { escapeInvalid: true },
];

function outcome(run) {
  try {
    return { value: run() };
  } catch (error) {
    return { error: `${error.constructor.name}: ${error.message}` };
  }
}

function astShape(ast) {
  return JSON.stringify(ast, (key, value) =>
    key === 'parent' || key === 'prev' ? undefined : value,
  );
}

describe('braces 3.0.4-nexus.1 security build (GHSA-vfj7-8cjw-p6xm)', () => {
  let upstreamDir;
  let upstream;
  let patched;

  beforeAll(() => {
    upstreamDir = materializeUpstreamBraces();
    upstream = require(path.join(upstreamDir, 'index.js'));
    patched = require(path.join(compatRoot, 'index.js'));
  });

  afterAll(() => {
    if (upstreamDir) fs.rmSync(upstreamDir, { recursive: true, force: true });
  });

  it('keeps every copied file byte-for-byte and the patched file pinned', () => {
    expect(provenance.npmPackage).toBe('braces@3.0.3');
    expect(provenance.nexusVersion).toBe('3.0.4-nexus.1');
    const patchedFiles = provenance.files.filter(
      (file) => file.type === 'patched',
    );
    expect(patchedFiles.map((file) => file.originalPath)).toEqual([
      'lib/parse.js',
    ]);
    for (const file of provenance.files) {
      const actual = sha256(fs.readFileSync(path.join(root, file.nexusPath)));
      if (file.type === 'patched') {
        expect(actual, file.nexusPath).toBe(file.nexusSha256);
        expect(actual, file.nexusPath).not.toBe(file.originalSha256);
        expect(file.changeSummary).toContain('GHSA-vfj7-8cjw-p6xm');
      } else {
        expect(file.type, file.nexusPath).toBe('copied');
        expect(actual, file.nexusPath).toBe(file.originalSha256);
      }
    }
    expect(
      fs.readFileSync(path.join(root, provenance.licenseFile), 'utf8'),
    ).toBe(fs.readFileSync(path.join(compatRoot, 'LICENSE'), 'utf8'));
  });

  it('keeps every provenance payload visible to a clean Git checkout', () => {
    for (const nexusPath of [
      ...provenance.files.map((file) => file.nexusPath),
      'third_party/braces-compat/package.json',
      'third_party/braces-compat/NOTICE.md',
      provenance.licenseFile,
    ]) {
      const result = spawnSync(
        'git',
        ['check-ignore', '--no-index', '--quiet', '--', nexusPath],
        { cwd: root, encoding: 'utf8', timeout: 5_000 },
      );
      expect(result.error, nexusPath).toBeUndefined();
      expect(result.status, nexusPath).toBe(1);
    }
  });

  it('rejects nesting deeper than 512 levels with a SyntaxError', () => {
    const atLimit = [
      nested('{', '}', MAX_DEPTH),
      nested('(', ')', MAX_DEPTH),
      '{('.repeat(MAX_DEPTH / 2) + 'a' + ')}'.repeat(MAX_DEPTH / 2),
      nested('{a,', '}', MAX_DEPTH, 'b'),
    ];
    for (const pattern of atLimit) {
      expect(() => patched(pattern)).not.toThrow();
      expect(() => patched(pattern, { expand: true })).not.toThrow();
      expect(() => patched.stringify(pattern)).not.toThrow();
    }

    const message = `Input nesting depth (${MAX_DEPTH + 1}), exceeds max depth (${MAX_DEPTH})`;
    for (const pattern of [
      nested('{', '}', MAX_DEPTH + 1),
      nested('(', ')', MAX_DEPTH + 1),
      '{('.repeat(MAX_DEPTH / 2) + '{a}' + ')}'.repeat(MAX_DEPTH / 2),
      '{'.repeat(MAX_DEPTH + 1) + 'a',
    ]) {
      for (const run of [
        () => patched(pattern),
        () => patched(pattern, { expand: true }),
        () => patched.stringify(pattern),
        () => patched.parse(pattern),
      ]) {
        expect(run).toThrow(SyntaxError);
        expect(run).toThrow(message);
      }
    }
  });

  it('stops the advisory attack: thousands of levels fail fast instead of overflowing', () => {
    const entrypoint = path.join(compatRoot, 'index.js');
    for (const depth of [1_000, 3_500, 4_999]) {
      const results = attackInChild(entrypoint, depth);
      for (const [probe, result] of Object.entries(results)) {
        expect(result.outcome, `${probe} @ ${depth}`).toBe('SyntaxError');
        expect(result.message).toContain('exceeds max depth (512)');
        expect(result.ms, `${probe} @ ${depth}`).toBeLessThan(1_000);
      }
    }
  });

  it('positive control: the same input exhausts the stack in upstream 3.0.3', () => {
    // A halved stack keeps the control deterministic across V8 JIT states;
    // the patched build still handles the 512-level maximum with it.
    const controlStack = ['--stack-size=500'];
    const upstreamResults = attackInChild(
      path.join(upstreamDir, 'index.js'),
      4_999,
      controlStack,
    );
    for (const probe of [
      'braces.compile',
      'braces.expand',
      'braces.stringify',
      'parens.compile',
      'parens.expand',
      'parens.stringify',
    ]) {
      expect(upstreamResults[probe].outcome, probe).toBe('RangeError');
    }

    const patchedAtLimit = attackInChild(
      path.join(compatRoot, 'index.js'),
      MAX_DEPTH,
      controlStack,
    );
    for (const [probe, result] of Object.entries(patchedAtLimit)) {
      expect(result.outcome, probe).toBe('ok');
    }
  });

  it('matches upstream 3.0.3 output across real glob patterns and options', () => {
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      let compared = 0;
      for (const pattern of CORPUS) {
        expect(astShape(patched.parse(pattern)), pattern).toBe(
          astShape(upstream.parse(pattern)),
        );
        expect(outcome(() => patched.stringify(pattern)), pattern).toEqual(
          outcome(() => upstream.stringify(pattern)),
        );
        for (const options of OPTION_SETS) {
          const label = `${pattern} ${JSON.stringify(options)}`;
          expect(outcome(() => patched(pattern, options)), label).toEqual(
            outcome(() => upstream(pattern, options)),
          );
          expect(outcome(() => patched.compile(pattern, options)), label).toEqual(
            outcome(() => upstream.compile(pattern, options)),
          );
          expect(outcome(() => patched.expand(pattern, options)), label).toEqual(
            outcome(() => upstream.expand(pattern, options)),
          );
          compared += 1;
        }
      }
      expect(compared).toBe(CORPUS.length * OPTION_SETS.length);

      // Array input and the existing guards behave as upstream.
      expect(patched(CORPUS.slice(0, 8))).toEqual(upstream(CORPUS.slice(0, 8)));
      for (const [pattern, options] of [
        ['{1..100000}', { expand: true }],
        ['a'.repeat(10_001), {}],
        ['{a,b}', { maxLength: 3 }],
      ]) {
        expect(outcome(() => patched(pattern, options))).toEqual(
          outcome(() => upstream(pattern, options)),
        );
      }
    } finally {
      quiet.mockRestore();
    }
  });

  it('is the braces that micromatch and fast-glob load', () => {
    const compatEntrypoint = fs.realpathSync(path.join(compatRoot, 'index.js'));
    const micromatchRoot = path.dirname(
      require.resolve('micromatch/package.json'),
    );
    expect(
      fs.realpathSync(require.resolve('braces', { paths: [micromatchRoot] })),
    ).toBe(compatEntrypoint);

    const micromatch = require(micromatchRoot);
    expect(micromatch.braces('src/{a,b}/*.ts', { expand: true })).toEqual([
      'src/a/*.ts',
      'src/b/*.ts',
    ]);
    expect(micromatch.isMatch('src/main.ts', 'src/{main,renderer}.ts')).toBe(
      true,
    );
    expect(() => micromatch.braces(nested('{', '}', 4_000))).toThrow(
      SyntaxError,
    );

    const fastGlob = require('fast-glob');
    const found = fastGlob.sync('{scripts,third_party}/{braces-compat.test,braces-compat/index}.{mjs,js}', {
      cwd: root,
    });
    expect(found.sort()).toEqual([
      'scripts/braces-compat.test.mjs',
      'third_party/braces-compat/index.js',
    ]);
  });

  it('keeps the root lock and local override coherent', () => {
    const bracesEntries = Object.entries(packageLock.packages).filter(
      ([packagePath]) =>
        packagePath === 'node_modules/braces' ||
        packagePath.endsWith('/node_modules/braces'),
    );

    expect(packageJson.devDependencies.braces).toBe(
      'file:third_party/braces-compat',
    );
    expect(packageJson.overrides.braces).toBe('$braces');
    expect(packageLock.packages[''].devDependencies.braces).toBe(
      packageJson.devDependencies.braces,
    );
    expect(packageLock.packages['third_party/braces-compat']).toMatchObject({
      name: 'braces',
      version: '3.0.4-nexus.1',
      dev: true,
      license: 'MIT',
    });
    expect(require(path.join(compatRoot, 'package.json'))).toMatchObject({
      name: 'braces',
      version: '3.0.4-nexus.1',
      private: true,
    });
    expect(bracesEntries).toEqual([
      [
        'node_modules/braces',
        { resolved: 'third_party/braces-compat', link: true },
      ],
    ]);
  });
});
