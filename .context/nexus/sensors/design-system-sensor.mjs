#!/usr/bin/env node
/**
 * Design system sensor — checks that every design token DESIGN.md DECLARES is
 * really declared in the project's style files, with the value the document
 * documents.
 *
 * Exit 0 when document and code agree; exit 1 with a JSON report of findings
 * when DESIGN.md is missing, empty, or contradicted by the code.
 *
 * What counts as a token declaration — and why the rule is this narrow
 * -------------------------------------------------------------------
 * The previous version scraped `\d+px|\d+rem|\d+em`, `#hex`, `rgb()` and
 * `--prop` out of the ENTIRE document and then demanded that each scrap appear
 * in some style file. It could not tell a token table from a sentence, so the
 * house contract's own prose — "A 4px grid." — became a REQUIRED token that no
 * table declares (the space scale is written in rem). A project adopting the
 * whole floor verbatim failed with `spacing tokens ... not found: 4px`, and
 * `merge-validation-coordinator` turns that exit 1 into a blocked merge. The
 * contract Nexus writes with its own hands could not pass the sensor Nexus
 * ships. Worse, the cheapest way to "pass" was a CSS comment containing 4px:
 * obeying the document was impossible, faking it was trivial.
 *
 * So a token is declared only by shapes a human reads as a declaration, never
 * by prose:
 *
 *   1. TABLE ROW — first cell is the custom property (backticks optional),
 *      second cell is a code span holding the value:
 *          | `--color-accent` | `#7c86ff` | the single interactive accent |
 *   2. CSS CODE FENCE — a `--name: value` inside a fenced block marked
 *      css/scss/less/styl (or unmarked):
 *          ```css
 *          :root { --color-accent: #7c86ff; }
 *          ```
 *
 * Everything else — headings, sentences, bullet lists, inline code inside a
 * paragraph — declares nothing. The value cell must be a code span precisely
 * so a two-column glossary (`| --accent | the live accent |`) cannot be read
 * as documenting the value "the live accent".
 *
 * Because whole cells are compared, decimals survive: `0.8125rem` is the token
 * `0.8125rem`, not the phantom `8125rem` the old word-boundary regex produced
 * and then listed in an error message no human could look up.
 *
 * On the style side a declaration is `--name: value` with comments stripped
 * first, so a commented-out token cannot satisfy the gate. Obeying the
 * document must be the only way to pass it.
 *
 * What is actually compared
 * -------------------------
 * Not "does this string occur somewhere in some stylesheet" — a legacy palette
 * preserved elsewhere in the tree answered yes, which is how DESIGN.md was
 * once able to document the WRONG accent and still pass green — but "is this
 * token declared with the value the document gives it". That single change is
 * what makes colours verifiable at all: the old pattern list had no `oklch`
 * entry, so every colour in the house contract went unchecked and
 * `--color-canvas: red` passed. Here colour syntax is never enumerated; the
 * documented value is compared against the declared value of the same token.
 *
 * It also retires a check that only worked inside the Nexus repository: an
 * earlier drift detector read `src/renderer/styles/base.css` by hard-coded
 * path, which is dead by construction in the user projects this file is copied
 * into. Its intent — the document must not disagree with the code — is now the
 * general rule, in every project, with no path to guess.
 *
 * Honest silence, not silent green
 * --------------------------------
 * `findings` are contradictions and fail the gate. `notes` state, in the same
 * report, what could NOT be measured (no style files, no machine-readable
 * declarations). A sensor that verified nothing must say so rather than report
 * a pass that reads like evidence.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DESIGN_PATHS = [
  'DESIGN.md',
  '.context/docs/design-system.md',
];

const STYLE_GLOBS = [
  '**/*.css',
  '**/*.scss',
  '**/*.less',
  '**/*.styl',
  '**/styled*.ts',
  '**/styled*.tsx',
  '**/*style*.ts',
  '**/*style*.tsx',
  '**/tailwind.config.*',
];

const SKIP_DIRS = new Set([
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
]);

/**
 * Custom properties are case-SENSITIVE in CSS: `--Accent` and `--accent` are
 * two different properties. Names are compared verbatim for that reason; only
 * values are case-folded.
 */
const CUSTOM_PROPERTY = '--[A-Za-z0-9][A-Za-z0-9_-]*';

/** Fence info strings whose body is read as CSS. Anything else is ignored. */
const CSS_FENCE_INFO = new Set(['', 'css', 'scss', 'less', 'styl', 'stylus']);

/** A table row declares a token: `| --name | `value` | ... */
const TOKEN_TABLE_ROW = new RegExp(
  `^ {0,3}\\|\\s*\`?(${CUSTOM_PROPERTY})\`?\\s*\\|\\s*\`([^\`]+)\`\\s*(?:\\||$)`,
);

/** `--name: value`, terminated by `;`, a brace, or end of input. */
const CSS_DECLARATION = new RegExp(`(${CUSTOM_PROPERTY})\\s*:\\s*([^;{}]+)`, 'g');

const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** Keep messages readable when a whole floor is missing. */
const MAX_LISTED = 10;
const MAX_DECLARED_SHOWN = 4;

const DECLARATION_SYNTAX_HELP =
  'A token declaration is either a table row whose first cell is the custom ' +
  'property and whose second cell is a code span (| `--color-accent` | ' +
  '`#7c86ff` | ... |), or a `--name: value` inside a fenced code block marked ' +
  'css/scss/less/styl. Prose never declares a token.';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function findDesignMd(root) {
  for (const relative of DESIGN_PATHS) {
    const absolute = path.join(root, relative);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isFile() && !stat.isSymbolicLink()) return { relative, absolute };
    } catch {
      // continue
    }
  }
  return null;
}

function globToRegex(pattern) {
  // Single-pass: replaces encadeadas reprocessavam o texto inserido (o '*' do
  // '(?:.*/)?' virava '[^/]*'), e '**/*.css' nunca casava — o sensor achava
  // 0 style files e reportava falsos positivos contra o DESIGN.md.
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (pattern[i] === '.') {
      out += '\\.';
      i += 1;
    } else {
      out += pattern[i].replace(/[()+?^${}[\]|\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

const STYLE_FILE_REGEXES = STYLE_GLOBS.map(globToRegex);

function isStyleFile(file) {
  return STYLE_FILE_REGEXES.some((regex) => regex.test(file));
}

function walk(root, dir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, absolute, files);
    } else if (entry.isFile() && isStyleFile(relative)) {
      files.push(absolute);
    }
  }
}

/**
 * Whitespace around commas and quoting are insignificant in CSS values, so
 * `cubic-bezier(0.2, 0, 0, 1)` and `cubic-bezier(0.2,0,0,1)` are the same
 * value, and `"Segoe UI"` is the same family as `Segoe UI`. Nothing else is
 * normalized: `red` must not be allowed to equal `oklch(63% 0.25 29)`.
 */
function normalizeValue(raw) {
  return raw
    .replace(/[`'"]/g, '')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * A comment is not a declaration. Block comments go everywhere; line comments
 * only in dialects that have them (never in plain CSS), and never when the
 * `//` is a URL scheme separator.
 */
function stripStyleComments(content, extension) {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (extension === '.css') return withoutBlocks;
  return withoutBlocks.replace(/(^|[^:\w])\/\/[^\n]*/gm, '$1');
}

function cssDeclarations(content, extension) {
  const clean = stripStyleComments(content, extension);
  const declarations = [];
  for (const match of clean.matchAll(CSS_DECLARATION)) {
    const value = match[2].trim();
    if (value) declarations.push({ name: match[1], value });
  }
  return declarations;
}

/**
 * Separates fenced code blocks from prose so table scanning never reads inside
 * a fence and CSS scanning never reads outside one.
 */
function splitMarkdownFences(markdown) {
  const prose = [];
  const cssBlocks = [];
  let open = null;
  for (const line of markdown.split('\n')) {
    const fence = MARKDOWN_FENCE.exec(line);
    if (open) {
      const closes =
        fence !== null &&
        fence[1][0] === open.marker[0] &&
        fence[1].length >= open.marker.length &&
        fence[2] === '';
      if (closes) {
        if (CSS_FENCE_INFO.has(open.info)) cssBlocks.push(open.lines.join('\n'));
        open = null;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    if (fence) {
      open = { marker: fence[1], info: fence[2].toLowerCase(), lines: [] };
      continue;
    }
    prose.push(line);
  }
  // An unterminated fence still declared what it declared.
  if (open && CSS_FENCE_INFO.has(open.info)) cssBlocks.push(open.lines.join('\n'));
  return { prose: prose.join('\n'), cssBlocks };
}

/**
 * @returns {{ tokens: Map<string, Map<string, string>>, tableRows: number,
 *             fenceDeclarations: number }}
 *   tokens maps a property name to normalized-value -> value as written. A
 *   token legitimately carries several values (a light table and a dark one);
 *   every documented value must exist in the code.
 */
function designDeclarations(markdown) {
  const withoutHtmlComments = markdown.replace(/<!--[\s\S]*?-->/g, '\n');
  const { prose, cssBlocks } = splitMarkdownFences(withoutHtmlComments);
  const tokens = new Map();
  const add = (name, raw) => {
    const value = normalizeValue(raw);
    if (!value) return;
    if (!tokens.has(name)) tokens.set(name, new Map());
    const bucket = tokens.get(name);
    if (!bucket.has(value)) bucket.set(value, raw.trim());
  };

  let tableRows = 0;
  for (const line of prose.split('\n')) {
    const row = TOKEN_TABLE_ROW.exec(line);
    if (!row) continue;
    tableRows += 1;
    add(row[1], row[2]);
  }

  let fenceDeclarations = 0;
  for (const block of cssBlocks) {
    for (const declaration of cssDeclarations(block, '.css')) {
      fenceDeclarations += 1;
      add(declaration.name, declaration.value);
    }
  }

  return { tokens, tableRows, fenceDeclarations };
}

/**
 * @returns {Map<string, Map<string, { raw: string, file: string }>>}
 */
function styleDeclarations(root, files) {
  const tokens = new Map();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const extension = path.extname(file).toLowerCase();
    for (const declaration of cssDeclarations(content, extension)) {
      const value = normalizeValue(declaration.value);
      if (!value) continue;
      if (!tokens.has(declaration.name)) tokens.set(declaration.name, new Map());
      const bucket = tokens.get(declaration.name);
      if (!bucket.has(value)) {
        bucket.set(value, {
          raw: declaration.value.trim(),
          file: path.relative(root, file),
        });
      }
    }
  }
  return tokens;
}

function listed(values, limit = MAX_LISTED) {
  const head = values.slice(0, limit);
  const rest = values.length - head.length;
  return rest > 0 ? `${head.join(', ')} (+${rest} more)` : head.join(', ');
}

function compare(documented, declared) {
  const missing = [];
  const mismatched = [];
  for (const [name, values] of documented) {
    const live = declared.get(name);
    if (!live) {
      missing.push(name);
      continue;
    }
    const absent = [...values].filter(([normalized]) => !live.has(normalized));
    if (absent.length === 0) continue;
    mismatched.push({
      token: name,
      documented: absent.map(([, raw]) => raw),
      declared: [...live.values()].map((entry) => `${entry.raw} (${entry.file})`),
    });
  }
  return { missing, mismatched };
}

function main() {
  const root = process.cwd();
  const findings = [];
  const notes = [];

  const design = findDesignMd(root);
  if (!design) {
    findings.push({
      severity: 'high',
      message: 'No DESIGN.md found at project root or .context/docs/design-system.md',
    });
    console.log(JSON.stringify({ ok: false, findings, notes }, null, 2));
    process.exit(1);
  }

  const content = fs.readFileSync(design.absolute, 'utf8').trim();
  if (!content) {
    findings.push({ severity: 'high', message: `${design.relative} is empty` });
    console.log(JSON.stringify({ ok: false, findings, notes }, null, 2));
    process.exit(1);
  }

  const documented = designDeclarations(content);
  const styleFiles = [];
  walk(root, root, styleFiles);
  const declared = styleDeclarations(root, styleFiles);

  if (documented.tokens.size === 0) {
    notes.push(
      `${design.relative} declares no token this sensor can read, so NOTHING ` +
        `was verified — this run is not evidence that the design system is ` +
        `honored. ${DECLARATION_SYNTAX_HELP}`,
    );
  } else if (styleFiles.length === 0) {
    notes.push(
      `${design.relative} declares ${documented.tokens.size} token(s), but this ` +
        'project has no style file to reflect them into, so NOTHING was ' +
        'verified. This run is not evidence that the design system is honored.',
    );
  } else {
    const { missing, mismatched } = compare(documented.tokens, declared);

    if (missing.length > 0) {
      findings.push({
        severity: 'medium',
        message:
          `${design.relative} declares ${missing.length} token(s) that no style ` +
          `file declares: ${listed(missing)}. Declare them as CSS custom ` +
          'properties, or remove them from the document — an unadopted floor ' +
          'is not a floor.',
      });
    }

    for (const entry of mismatched.slice(0, MAX_LISTED)) {
      findings.push({
        severity: 'high',
        message:
          `${design.relative} documents \`${entry.token}\` = ` +
          `${entry.documented.join(' / ')}, but the style files declare ` +
          `${entry.token} as ${listed(entry.declared, MAX_DECLARED_SHOWN)}. ` +
          'This document is the authority a design mission reads: while it ' +
          'disagrees with the code, the next mission will restore whichever ' +
          'identity it believes.',
      });
    }
    if (mismatched.length > MAX_LISTED) {
      findings.push({
        severity: 'high',
        message:
          `${mismatched.length - MAX_LISTED} further token(s) documented in ` +
          `${design.relative} with a value no style file declares.`,
      });
    }
  }

  // ── Regras aprendidas na auditoria de UI (23/08) ─────────────────────
  // O validador só conferia hex e valor de token documentado. Estas duas
  // classes passavam em silêncio e custaram defeitos reais na tela.

  // 1) `var(--x)` sem fallback quando `--x` NUNCA é declarado.
  //    `--text-muted` e `--duration-fast` eram usados 8x cada e não existiam:
  //    a cor virava herdada e a transição, ignorada.
  // Escopo: SÓ o estilo próprio da aplicação. Manifests de skills
  // empacotadas (assets/skills) carregam CSS de terceiros como string e não
  // respondem à doutrina desta casa.
  const ownStyleFiles = styleFiles.filter((file) => {
    const relative = path.relative(root, file);
    return (
      relative.startsWith(`src${path.sep}`) &&
      !relative.includes(`${path.sep}assets${path.sep}`) &&
      !/manifest\.ts$/u.test(relative)
    );
  });

  const usedTokens = new Map();
  for (const file of ownStyleFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/gu)) {
      const token = match[1];
      if (!usedTokens.has(token)) {
        usedTokens.set(token, path.relative(root, file));
      }
    }
  }
  // Um token também pode ser declarado INLINE pelo componente
  // (`style={{ '--mission-agent-x': ... }}`) — é assim que posição e medida
  // calculadas em runtime chegam ao CSS. Isso é declaração legítima.
  const inlineDeclared = new Set();
  const componentDirs = [path.join(root, 'src')];
  const collectInline = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name === 'assets') continue;
        collectInline(absolute);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      const text = fs.readFileSync(absolute, 'utf8');
      for (const match of text.matchAll(/['"](--[A-Za-z0-9_-]+)['"]\s*:/gu)) {
        inlineDeclared.add(match[1]);
      }
    }
  };
  for (const dir of componentDirs) collectInline(dir);

  const undeclared = [...usedTokens.keys()]
    .filter((token) => !declared.has(token) && !inlineDeclared.has(token))
    .sort();
  if (undeclared.length > 0) {
    findings.push({
      severity: 'high',
      message:
        `${undeclared.length} token(s) used with no fallback are declared ` +
        `nowhere: ${listed(undeclared)}. An invalid var() silently inherits ` +
        '(color) or drops the declaration (duration) — the hierarchy the ' +
        'author wrote never reaches the screen. Declare the token, or give ' +
        'the usage an explicit fallback.',
    });
  }

  // 2) Keyframe sem guarda de prefers-reduced-motion no MESMO arquivo.
  //    DESIGN.md §4 exige a guarda em todo keyframe.
  const unguarded = [];
  for (const file of ownStyleFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/@keyframes\s/u.test(text)) continue;
    if (/prefers-reduced-motion/u.test(text)) continue;
    unguarded.push(path.relative(root, file));
  }
  if (unguarded.length > 0) {
    findings.push({
      severity: 'medium',
      message:
        `${unguarded.length} style file(s) declare @keyframes with no ` +
        `prefers-reduced-motion guard: ${listed(unguarded)}. DESIGN.md §4 ` +
        'requires the guard on every keyframe.',
    });
  }

  const report = {
    ok: findings.length === 0,
    designPath: design.relative,
    designHash: sha256(content),
    designTokens: documented.tokens.size,
    designTokenSources: {
      tableRows: documented.tableRows,
      cssFenceDeclarations: documented.fenceDeclarations,
    },
    styleFiles: styleFiles.length,
    styleTokens: declared.size,
    findings,
    notes,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
