#!/usr/bin/env node
/**
 * Design system sensor — validates that a DESIGN.md exists and that the
 * tokens it declares are reflected in the project's style files.
 *
 * Exit 0 when the design system is consistent; exit 1 with a JSON report
 * of findings when it is missing, empty, or has untokenized declarations.
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

const TOKEN_PATTERNS = [
  { kind: 'color', regex: /#[a-f0-9]{3,8}\b/gi },
  { kind: 'color', regex: /rgb\([^)]+\)/gi },
  { kind: 'color', regex: /rgba\([^)]+\)/gi },
  { kind: 'color', regex: /hsl\([^)]+\)/gi },
  { kind: 'font', regex: /font-family[:\s]+([^;\n]+)/gi },
  { kind: 'spacing', regex: /\b(\d+px|\d+rem|\d+em)\b/gi },
  // 1+ chars após '--': exclui o '---' de tabelas markdown no DESIGN.md sem
  // perder props legítimas de 1 char (ex.: --a/--t/--d do cost-operator.css).
  { kind: 'custom-property', regex: /--[a-z0-9](?:[a-z0-9_-]+)?/gi },
];

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

function extractTokens(content) {
  const tokens = [];
  for (const { kind, regex } of TOKEN_PATTERNS) {
    for (const match of content.matchAll(regex)) {
      const raw = match[1] ?? match[0];
      const normalized = raw.trim().replace(/['"]/g, '').toLowerCase();
      if (normalized) tokens.push({ kind, value: normalized });
    }
  }
  return tokens;
}

function main() {
  const root = process.cwd();
  const findings = [];

  const design = findDesignMd(root);
  if (!design) {
    findings.push({
      severity: 'high',
      message: 'No DESIGN.md found at project root or .context/docs/design-system.md',
    });
    console.log(JSON.stringify({ ok: false, findings }, null, 2));
    process.exit(1);
  }

  const content = fs.readFileSync(design.absolute, 'utf8').trim();
  if (!content) {
    findings.push({ severity: 'high', message: `${design.relative} is empty` });
    console.log(JSON.stringify({ ok: false, findings }, null, 2));
    process.exit(1);
  }

  const designTokens = extractTokens(content);
  const styleFiles = [];
  walk(root, root, styleFiles);

  const styleContent = styleFiles
    .map((file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const styleTokens = new Set(extractTokens(styleContent).map((t) => `${t.kind}:${t.value}`));

  const untokenized = [];
  for (const token of designTokens) {
    if (!styleTokens.has(`${token.kind}:${token.value}`)) {
      untokenized.push(token);
    }
  }

  if (untokenized.length > 0) {
    const byKind = new Map();
    for (const token of untokenized) {
      if (!byKind.has(token.kind)) byKind.set(token.kind, []);
      byKind.get(token.kind).push(token);
    }
    for (const [kind, items] of byKind.entries()) {
      const values = [...new Set(items.map((t) => t.value))].slice(0, 10);
      findings.push({
        severity: 'medium',
        message: `${kind} tokens from ${design.relative} not found in style files: ${values.join(', ')}`,
      });
    }
  }

  const report = {
    ok: findings.length === 0,
    designPath: design.relative,
    designHash: sha256(content),
    designTokens: designTokens.length,
    styleFiles: styleFiles.length,
    findings,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
