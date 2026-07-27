import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-sensor-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'src', 'theme', 'nested'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'DESIGN.md'),
    [
      '# Design system',
      '',
      '- Accent: `#123456`',
      '- Spacing: `12px`',
      '- Token: `--accent`',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'root.css'),
    ':root { --accent: #123456; gap: 12px; }\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'theme', 'nested', 'component.css'),
    '.component { color: var(--accent); }\n',
  );
  return root;
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

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('design system sensor recursive style discovery', () => {
  it.each(sensorPaths)(
    'matches root and deeply nested CSS through **/ in %s',
    (sensorPath) => {
      const result = runSensor(sensorPath, createFixture());

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
