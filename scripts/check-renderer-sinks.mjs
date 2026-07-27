#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/renderer', 'src/preload'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SINKS = [
  { name: 'innerHTML assignment', pattern: /\.innerHTML\s*=(?!=)/u },
  { name: 'outerHTML assignment', pattern: /\.outerHTML\s*=(?!=)/u },
  { name: 'insertAdjacentHTML()', pattern: /\.insertAdjacentHTML\s*\(/u },
  { name: 'document.write()', pattern: /document\.writeln?\s*\(/u },
  {
    name: 'createContextualFragment()',
    pattern: /\.createContextualFragment\s*\(/u,
  },
  { name: 'eval()', pattern: /(?<![\w.])eval\s*\(/u },
  { name: 'new Function()', pattern: /new\s+Function\s*\(/u },
  {
    name: 'dangerouslySetInnerHTML',
    pattern: /\bdangerouslySetInnerHTML\b/u,
  },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) =>
      comment.replace(/[^\n]/gu, ' '),
    )
    .replace(/(^|[^:"'`])\/\/[^\n]*/gmu, '$1');
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(candidate);
      continue;
    }
    if (
      EXTENSIONS.has(path.extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)
    ) {
      yield candidate;
    }
  }
}

const findings = [];
for (const root of ROOTS) {
  for (const filePath of walk(root)) {
    const lines = stripComments(fs.readFileSync(filePath, 'utf8')).split('\n');
    for (const sink of SINKS) {
      lines.forEach((line, index) => {
        if (sink.pattern.test(line)) {
          findings.push(`${filePath}:${index + 1} ${sink.name}`);
        }
      });
    }
  }
}

if (findings.length > 0) {
  console.error(
    `renderer sink audit: ${findings.length} executable DOM sink(s) found`,
  );
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exit(1);
}

console.log('renderer sink audit: 0 executable DOM sinks');
