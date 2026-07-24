import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stageRealMissionE2EContextCorpus } from './real-mission-e2e-prevc';

describe('stage PREVC corpus', () => {
  it('stages without throw', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prevc-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    expect(() => stageRealMissionE2EContextCorpus(root)).not.toThrow();
    expect(fs.existsSync(path.join(root, '.context/docs/architecture.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });
});
