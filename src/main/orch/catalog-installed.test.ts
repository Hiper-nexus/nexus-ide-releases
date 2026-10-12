import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listInstalledCatalogItems } from './catalog-installed';

const homes: string[] = [];

function fakeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-catalog-installed-'));
  homes.push(home);
  return home;
}

function installSkill(home: string, homeDir: string, name: string): string {
  const dir = path.join(home, homeDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: skill ${name}\n---\n`,
  );
  return dir;
}

afterEach(() => {
  for (const home of homes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  homes.length = 0;
});

describe('listInstalledCatalogItems', () => {
  it('F-1305: pasta de skill sem SKILL.md não entra no inventário', () => {
    const home = fakeHome();
    // Pasta fantasma: diretório sem SKILL.md legível.
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'ghost-no-skillmd'), {
      recursive: true,
    });
    // Pasta real.
    installSkill(home, '.claude/skills', 'real-skill');

    const names = listInstalledCatalogItems(home).map((item) => item.name);
    expect(names).toContain('real-skill');
    expect(names).not.toContain('ghost-no-skillmd');
  });

  it('F-1308: nome duplicado entre homes expõe qual cópia venceu (shadowedFrom)', () => {
    const home = fakeHome();
    const winner = installSkill(home, '.claude/skills', 'dup-skill');
    const shadowed = installSkill(home, '.agents/skills', 'dup-skill');

    const items = listInstalledCatalogItems(home).filter(
      (item) => item.name === 'dup-skill',
    );
    // first-wins: .claude/skills vence .agents/skills.
    expect(items).toHaveLength(1);
    expect(items[0]!.file).toBe(winner);
    // A vencedora aponta de onde saiu a cópia ofuscada.
    expect(items[0]!.shadowedFrom).toEqual([shadowed]);
  });
});
