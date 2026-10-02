import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function compilerFixture({ major, compileExit, standardLibrary = 12 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-compiler-gate-'));
  fixtures.push(root);
  const executable = '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("Ubuntu clang version ' + major + '.0.7"); process.exit(0); }',
    'if (args[0] === "-dumpversion") { console.log("' + major + '.0.7"); process.exit(0); }',
    'if (args[0] === "-print-search-dirs") { console.log("libraries: =/usr/lib/gcc/x86_64-linux-gnu/' + standardLibrary + '"); process.exit(0); }',
    'if (!args.includes("-fsyntax-only") || !args.includes("-std=c++20")) process.exit(90);',
    'const source = fs.readFileSync(0, "utf8");',
    'if (!source.includes("[[deprecated") || !source.includes("visibility")) process.exit(91);',
    'process.exit(' + compileExit + ');',
  ].join('\n');
  for (const name of ['clang-15', 'clang++-15']) {
    fs.writeFileSync(path.join(root, name), executable, { mode: 0o755 });
  }
  return root;
}

describe.skipIf(process.platform === 'win32')('Linux native compiler gate', () => {
  for (const file of ['linux-preview.yml', 'linux-release.yml']) {
    const workflow = parse(fs.readFileSync(new URL('../.github/workflows/' + file, import.meta.url), 'utf8'));
    const job = workflow.jobs.build;
    const gate = job.steps.find((step) => step.name === 'Verify Linux native C++20 compiler');
    it.each([
      { label: 'accepts the compatible compiler', major: 15, compileExit: 0, expected: 0 },
      { label: 'rejects an unsupported compiler version', major: 11, compileExit: 0, expected: 1 },
      { label: 'rejects a different selected GCC standard library', major: 15, standardLibrary: 13, compileExit: 0, expected: 1 },
      { label: 'propagates a native header syntax failure', major: 15, compileExit: 23, expected: 23 },
    ])(file + ': $label', ({ major, compileExit, standardLibrary, expected }) => {
      expect(gate, 'native compiler must be checked before any rebuild').toBeDefined();
      const bin = compilerFixture({ major, compileExit, standardLibrary });
      const result = spawnSync('bash', ['-c', gate.run], {
        env: { ...process.env, ...job.env, PATH: bin + path.delimiter + process.env.PATH },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(expected);
      const gateIndex = job.steps.indexOf(gate);
      const installIndex = job.steps.findIndex((step) => step.run?.includes('npm ci'));
      const makeIndex = job.steps.findIndex((step) => step.run?.includes('npm run make'));
      expect(gateIndex).toBeLessThan(installIndex);
      expect(gateIndex).toBeLessThan(makeIndex);
    });
  }
});
