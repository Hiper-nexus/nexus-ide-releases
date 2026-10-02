import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desktopIdentityProblems,
  mimeCacheListsHandler,
  parseDesktopEntry,
} from './verify-linux-desktop-identity.mjs';

const brandIcon = fs.readFileSync(new URL('../assets/icon.png', import.meta.url));
const electronDefault = Buffer.from('electron default icon bytes');

const GOOD_ENTRY = [
  '[Desktop Entry]',
  'Name=NexusIDE',
  'GenericName=IDE multi-agente',
  'Exec=nexus-ide %U',
  'Icon=nexus-ide',
  'Type=Application',
  'StartupNotify=true',
  'Categories=Development;',
  'MimeType=x-scheme-handler/nexus;',
  '',
].join('\n');

/** A entrada que a 0.76.166 realmente publicou (extraída do .deb do espelho). */
const SHIPPED_0_76_166 = [
  '[Desktop Entry]',
  'Name=NexusIDE',
  'GenericName=NexusIDE',
  'Exec=nexus-ide %U',
  'Icon=nexus-ide',
  'Type=Application',
  'StartupNotify=true',
  'Categories=GNOME;GTK;Utility;',
  '',
].join('\n');

function input(overrides = {}) {
  return {
    desktopEntry: GOOD_ENTRY,
    installedIcon: brandIcon,
    brandIcon,
    installerDefaultIcons: [electronDefault],
    desktopName: 'nexus-ide.desktop',
    ...overrides,
  };
}

describe('installed Linux desktop identity', () => {
  it('accepts the brand icon plus the nexus:// handler', () => {
    expect(desktopIdentityProblems(input())).toEqual([]);
  });

  it('rejects what 0.76.166 shipped: no login handler, Electron icon, Utility menu', () => {
    const problems = desktopIdentityProblems(
      input({ desktopEntry: SHIPPED_0_76_166, installedIcon: electronDefault, desktopName: undefined }),
    );
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/desktopName/);
    expect(problems.join('\n')).toMatch(/MimeType=x-scheme-handler\/nexus/);
    expect(problems.join('\n')).toMatch(/categoria Development/);
    expect(problems.join('\n')).toMatch(/padrão do Electron/);
  });

  it('rejects an icon that is neither the default nor the brand', () => {
    expect(desktopIdentityProblems(input({ installedIcon: Buffer.from('other') }))).toEqual([
      'o ícone instalado difere de assets/icon.png',
    ]);
  });

  it('reports files the package did not install', () => {
    expect(
      desktopIdentityProblems(input({ desktopEntry: undefined, installedIcon: undefined })),
    ).toEqual([
      '/usr/share/applications/nexus-ide.desktop não foi instalado',
      '/usr/share/pixmaps/nexus-ide.png não foi instalado',
    ]);
  });

  it('requires the installed MIME index to list the handler (F-740)', () => {
    const listed = '[MIME Cache]\ntext/html=a.desktop;\nx-scheme-handler/nexus=nexus-ide.desktop;\n';
    expect(desktopIdentityProblems(input({ mimeCache: listed }))).toEqual([]);
    // O que aconteceu no Omarchy: entrada e padrão corretos, índice sem a linha.
    for (const stale of [null, '', '[MIME Cache]\ntext/html=a.desktop;\n']) {
      const problems = desktopIdentityProblems(input({ mimeCache: stale }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/mimeinfo\.cache não lista nexus-ide\.desktop/);
    }
    expect(mimeCacheListsHandler('[MIME Cache]\nx-scheme-handler/nexus-shot=nexus-ide.desktop;\n', 'nexus-ide.desktop')).toBe(false);
    expect(mimeCacheListsHandler('[Other]\nx-scheme-handler/nexus=nexus-ide.desktop;\n', 'nexus-ide.desktop')).toBe(false);
  });

  it('reads only the main group and lets the first key win', () => {
    const entry = parseDesktopEntry(
      '# comentário\n[Desktop Entry]\nExec=nexus-ide %U\nExec=evil\n[Desktop Action x]\nMimeType=x-scheme-handler/nexus;\n',
    );
    expect(entry.get('Exec')).toBe('nexus-ide %U');
    expect(entry.has('MimeType')).toBe(false);
  });

  it('keeps the checked package.json in sync with the installed entry name', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.desktopName).toBe('nexus-ide.desktop');
    expect(pkg.name).toBe('nexus-ide');
  });
});

describe.skipIf(process.platform === 'win32')('running the check as a script', () => {
  it('does not exit 0 in silence when invoked through a symlinked path (review 02/10)', () => {
    // O guarda comparava argv[1] cru com o caminho real: por um symlink ele não
    // reconhecia o próprio script, não rodava nada e saía 0 — um gate que passa
    // sem conferir. Qualquer saída do script (ok ou FAIL) prova que ele rodou.
    const real = path.resolve('scripts');
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-identity-link-'));
    try {
      const link = path.join(holder, 'scripts');
      fs.symlinkSync(real, link);
      const result = spawnSync(process.execPath, [path.join(link, 'verify-linux-desktop-identity.mjs')], {
        encoding: 'utf8',
      });
      expect(`${result.stdout}${result.stderr}`).toMatch(/\[linux-desktop-identity\] (ok|FAIL)/);
    } finally {
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });
});
