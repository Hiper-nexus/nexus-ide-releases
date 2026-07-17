import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSkillsForCli } from './skill-mirror';

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skill-mirror-'));
  roots.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, body = '# Skill'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureSkillsForCli', () => {
  it('mirrors installed skills into the Codex namespace', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
    });

    expect(result.mirrored).toBeGreaterThanOrEqual(2);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'impeccable', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'ponytail', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'archify', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'bridgeward', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'bridgesecurity', 'SKILL.md')),
    ).toBe(true);
  });

  it('discovers a skill installed only in the Gemini namespace', () => {
    const home = tmpRoot();
    writeSkill(path.join(home, '.gemini', 'config', 'skills'), 'gemini-only');

    ensureSkillsForCli('codex', { home });

    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'gemini-only', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('honors an empty allowedSkills list as explicit no-skills policy', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
      allowedSkills: [],
    });

    expect(result.mirrored).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
  });

  it('copies only allowlisted skills when a skill allowlist is present', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');
    writeSkill(source, 'security-best-practices');

    ensureSkillsForCli('agy', {
      home,
      sourceDirs: [source],
      allowedSkills: ['impeccable'],
    });

    const target = path.join(home, '.gemini', 'antigravity', 'skills');
    expect(fs.existsSync(path.join(target, 'impeccable', 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(target, 'security-best-practices', 'SKILL.md')),
    ).toBe(false);
    expect(fs.existsSync(path.join(target, 'ponytail', 'SKILL.md'))).toBe(false);
  });

  it('mirrors into Claude ephemeral homes for gated Claude-like workers', () => {
    const home = tmpRoot();
    const ephemeral = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    ensureSkillsForCli('claude', {
      home,
      sourceDirs: [source],
      ephemeralHomeDir: ephemeral,
    });

    expect(
      fs.existsSync(
        path.join(ephemeral, '.claude', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.claude', 'skills', 'impeccable', 'SKILL.md')),
    ).toBe(true);
  });

  it('mirrors Kimi skills to the Kimi user skill directory without argv changes', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('kimi', {
      home,
      sourceDirs: [source],
    });

    expect(result.targetDirs).toContain(path.join(home, '.kimi-code', 'skills'));
    expect(
      fs.existsSync(path.join(home, '.kimi-code', 'skills', 'impeccable', 'SKILL.md')),
    ).toBe(true);
  });

  it('mirrors OpenCode skills to its official user skill directory', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('opencode', {
      home,
      sourceDirs: [source],
    });

    expect(result.targetDirs).toContain(
      path.join(home, '.config', 'opencode', 'skills'),
    );
    expect(
      fs.existsSync(
        path.join(home, '.config', 'opencode', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
  });
});
