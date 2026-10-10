// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NEXUS_DELIVERED_SKILL_MARKER,
  deliverGrantedSkillsToProviderHome,
  listNexusDeliveredSkills,
  mirrorGovernedSkills,
} from './cli-mcp-session-governance';
import { registerHardenedSpawnPolicy } from './gate';
import { sharedSkillCacheDir } from './skill-mirror';

let home = '';
let providerSkillsDir = '';

function installUserSkill(name: string, body = '# skill\n'): void {
  const dir = path.join(home, '.codex', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-governance-home-')),
  );
  providerSkillsDir = path.join(home, '.codex', 'skills');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('deliverGrantedSkillsToProviderHome', () => {
  it('marks every skill it materialized in the real provider profile', () => {
    // A skill the user already had, in a DIFFERENT provider profile, so the
    // delivery has to copy it into ~/.codex/skills.
    const sourceDir = path.join(home, '.claude', 'skills', 'ponytail');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# ponytail\n');

    const result = deliverGrantedSkillsToProviderHome(
      'codex',
      home,
      providerSkillsDir,
      ['ponytail'],
    );

    expect(result.mirrored).toBeGreaterThanOrEqual(1);
    const marker = path.join(
      providerSkillsDir,
      'ponytail',
      NEXUS_DELIVERED_SKILL_MARKER,
    );
    expect(fs.existsSync(marker)).toBe(true);
    const record = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
      deliveredBy: string;
      skill: string;
      adapterId: string;
      deliveredAt: string;
    };
    expect(record.deliveredBy).toBe('nexus');
    expect(record.skill).toBe('ponytail');
    expect(record.adapterId).toBe('codex');
    expect(Number.isFinite(Date.parse(record.deliveredAt))).toBe(true);

    expect(listNexusDeliveredSkills(providerSkillsDir)).toContain('ponytail');
  });

  it("never claims a skill the user installed himself", () => {
    installUserSkill('mine', '# mine, not nexus\n');

    deliverGrantedSkillsToProviderHome('codex', home, providerSkillsDir, [
      'mine',
    ]);

    expect(
      fs.existsSync(
        path.join(providerSkillsDir, 'mine', NEXUS_DELIVERED_SKILL_MARKER),
      ),
    ).toBe(false);
    expect(fs.readFileSync(
      path.join(providerSkillsDir, 'mine', 'SKILL.md'),
      'utf8',
    )).toBe('# mine, not nexus\n');
    expect(listNexusDeliveredSkills(providerSkillsDir)).toEqual([]);
  });

  it('materializes nothing — and marks nothing — for an empty grant', () => {
    const result = deliverGrantedSkillsToProviderHome(
      'codex',
      home,
      providerSkillsDir,
      [],
    );

    expect(result.mirrored).toBe(0);
    expect(listNexusDeliveredSkills(providerSkillsDir)).toEqual([]);
  });
});

describe('mirrorGovernedSkills — shared cache (F-1157)', () => {
  function userSkill(root: string, name: string, body: string): void {
    const dir = path.join(home, root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  }

  it('links a fresh private overlay to one shared cache with every skill (Autopilot)', () => {
    userSkill('.claude/skills', 'mine-claude', '# claude\n');
    userSkill('.agents/skills', 'mine-agents', '# agents\n');
    const overlayA = path.join(home, 'overlay-a', 'skills');
    const overlayB = path.join(home, 'overlay-b', 'skills');

    mirrorGovernedSkills('grok', home, [overlayA], ['mine-claude'], null);
    mirrorGovernedSkills('grok', home, [overlayB], [], null);

    const cache = sharedSkillCacheDir('grok', home);
    for (const overlay of [overlayA, overlayB]) {
      expect(fs.lstatSync(overlay).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(overlay)).toBe(fs.realpathSync(cache));
      // No skill filter: the ungranted skill is there too.
      expect(fs.existsSync(path.join(overlay, 'mine-claude', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(overlay, 'mine-agents', 'SKILL.md'))).toBe(true);
    }
    // The real provider profiles were never written.
    expect(fs.existsSync(path.join(home, '.grok', 'skills'))).toBe(false);
  });

  it('copies real files when the overlay is sandboxed (Hardened or an explicit opt-out)', () => {
    userSkill('.claude/skills', 'mine-claude', '# claude\n');
    const explicit = path.join(home, 'codex-artifact', 'skills');
    mirrorGovernedSkills('codex', home, [explicit], [], null, { linkToSharedCache: false });
    expect(fs.lstatSync(explicit).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(explicit, 'mine-claude', 'SKILL.md'))).toBe(true);

    registerHardenedSpawnPolicy(() => true);
    try {
      const hardened = path.join(home, 'kimi-overlay', 'skills');
      mirrorGovernedSkills('kimi', home, [hardened], [], null);
      expect(fs.lstatSync(hardened).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(hardened, 'mine-claude', 'SKILL.md'))).toBe(true);
    } finally {
      registerHardenedSpawnPolicy(() => false);
    }
  });

  it('never replaces an overlay that already holds content; it copies into it instead', () => {
    userSkill('.claude/skills', 'mine-claude', '# claude\n');
    const overlay = path.join(home, 'busy-overlay', 'skills');
    fs.mkdirSync(path.join(overlay, 'theirs'), { recursive: true });
    fs.writeFileSync(path.join(overlay, 'theirs', 'SKILL.md'), '# theirs\n');
    mirrorGovernedSkills('grok', home, [overlay], [], null);
    expect(fs.lstatSync(overlay).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(overlay, 'theirs', 'SKILL.md'), 'utf8')).toBe('# theirs\n');
    expect(fs.existsSync(path.join(overlay, 'mine-claude', 'SKILL.md'))).toBe(true);
  });

  it('refreshes a cached user skill whose SKILL.md changed after it was cached', () => {
    userSkill('.claude/skills', 'evolving', '# v1\n');
    const cache = sharedSkillCacheDir('grok', home);
    expect(fs.readFileSync(path.join(cache, 'evolving', 'SKILL.md'), 'utf8')).toBe('# v1\n');
    const source = path.join(home, '.claude', 'skills', 'evolving', 'SKILL.md');
    fs.writeFileSync(source, '# v2\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(source, later, later);
    sharedSkillCacheDir('grok', home);
    expect(fs.readFileSync(path.join(cache, 'evolving', 'SKILL.md'), 'utf8')).toBe('# v2\n');
  });
});
