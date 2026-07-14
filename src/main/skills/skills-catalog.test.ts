import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  buildLockFromCatalog,
  detectSkillDrift,
  digestSkillContent,
  scanSkillsDirectory,
  uninstallAllSkillsLock,
  writeSkillsLock,
} from './skills-catalog';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('skills catalog', () => {
  it('scans SKILL.md, locks digests, detects drift, uninstalls with backup', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.skillsCatalog, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skills-'));
    dirs.push(dir);
    const skillDir = path.join(dir, 'ponytail');
    fs.mkdirSync(skillDir);
    const body = '---\ndescription: lean senior\n---\n\n## Plan\n## Do\n';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);

    const catalog = scanSkillsDirectory(dir);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.phases).toBeGreaterThanOrEqual(2);
    expect(catalog[0]?.digest).toBe(digestSkillContent(body));

    const lock = buildLockFromCatalog(catalog);
    const lockPath = path.join(dir, 'skills.lock.json');
    writeSkillsLock(lockPath, lock);

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${body}\nchanged\n`);
    const drifted = detectSkillDrift(lock, scanSkillsDirectory(dir));
    expect(drifted).toContain('ponytail');

    const { backupPath } = uninstallAllSkillsLock(lockPath);
    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
