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

describe('mirrorGovernedSkills (F-1157)', () => {
  it('copies every installed skill into a fresh private overlay and never writes the real profile', () => {
    for (const [root, name] of [['.claude/skills', 'mine-claude'], ['.agents/skills', 'mine-agents']] as const) {
      fs.mkdirSync(path.join(home, root, name), { recursive: true });
      fs.writeFileSync(path.join(home, root, name, 'SKILL.md'), `# ${name}\n`);
    }
    const overlay = path.join(home, 'overlay', 'skills');
    mirrorGovernedSkills('grok', home, [overlay], ['mine-claude'], null);
    expect(fs.lstatSync(overlay).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(overlay, 'mine-claude', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(overlay, 'mine-agents', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.grok', 'skills'))).toBe(false);
  });
});
