import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LINUX_DESKTOP_FILE_NAME,
  LINUX_PORTABLE_MARKER,
  buildPortableDesktopEntry,
  desktopExecToken,
  ensureLinuxDesktopEntry,
  ensureMimeIndex,
  mergeMimeCacheHandler,
  mimeCacheListsHandler,
  isPackageManagedExecutable,
  isPlainDesktopExecPath,
  linuxLauncherLinkPath,
  linuxUserDesktopEntryPath,
  planLinuxDesktopEntry,
  quoteDesktopExecArg,
  resolveLinuxRuntimeIconPath,
  type LinuxDesktopEntryInput,
} from './linux-desktop-entry';

const HOME = '/home/u';
const USER_FILE = '/home/u/.local/share/applications/nexus-ide.desktop';
const SYSTEM_FILE = '/usr/share/applications/nexus-ide.desktop';
const PORTABLE_EXEC = '/home/u/apps/NexusIDE-linux-x64/nexus-ide';

function input(overrides: Partial<LinuxDesktopEntryInput> = {}): LinuxDesktopEntryInput {
  return {
    platform: 'linux',
    isPackaged: true,
    automatedTest: false,
    execPath: PORTABLE_EXEC,
    iconPath: '/home/u/apps/NexusIDE-linux-x64/resources/icon.png',
    homeDir: HOME,
    env: {},
    readEntry: () => null,
    entryExists: () => false,
    readLink: () => null,
    ...overrides,
  };
}

describe('desktop identity', () => {
  it('matches the desktopName Electron uses for app_id and protocol registration', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { desktopName?: string };
    // Sem isto o Electron 43 cai no slug `nexuside.desktop`, que nenhum pacote
    // instala: a janela fica sem ícone e o nexus:// do login não é registrado.
    expect(pkg.desktopName).toBe(LINUX_DESKTOP_FILE_NAME);
  });
});

describe('quoteDesktopExecArg', () => {
  it('quotes a plain path', () => {
    expect(quoteDesktopExecArg('/opt/NexusIDE/nexus-ide')).toBe('"/opt/NexusIDE/nexus-ide"');
  });

  it('keeps spaces inside the quotes', () => {
    expect(quoteDesktopExecArg('/home/u/Meus Apps/nexus-ide')).toBe(
      '"/home/u/Meus Apps/nexus-ide"',
    );
  });

  it('escapes shell-significant characters twice (quoting rule + string rule)', () => {
    // Spec: um `$` literal num argumento entre aspas é `\\$` no arquivo; uma
    // barra literal são quatro barras.
    expect(quoteDesktopExecArg('/a/$HOME/x')).toBe('"/a/\\\\$HOME/x"');
    expect(quoteDesktopExecArg('/a/b\\c')).toBe('"/a/b\\\\\\\\c"');
    expect(quoteDesktopExecArg('/a/"q"/`t`')).toBe('"/a/\\\\"q\\\\"/\\\\`t\\\\`"');
  });

  it('doubles percent so it is not read as a field code', () => {
    expect(quoteDesktopExecArg('/a/100%/nexus-ide')).toBe('"/a/100%%/nexus-ide"');
  });

  it('refuses paths the format cannot carry', () => {
    expect(quoteDesktopExecArg('')).toBeNull();
    expect(quoteDesktopExecArg('/a/b\nExec=evil')).toBeNull();
    expect(quoteDesktopExecArg('/a/b\u0007')).toBeNull();
  });
});

describe('desktopExecToken', () => {
  const LINK = '/home/u/.local/share/nexus-ide/nexus-ide';

  it('writes a plain path unquoted: generic xdg-open cannot run a quoted Exec', () => {
    // Medido no Omarchy: com `Exec="/caminho/nexus-ide" %U` o xdg-open procura
    // um comando chamado `"/caminho/nexus-ide"` (com as aspas), não acha e
    // entrega o nexus:// ao navegador.
    expect(desktopExecToken(PORTABLE_EXEC, LINK)).toEqual({ exec: PORTABLE_EXEC });
    expect(isPlainDesktopExecPath('/home/joão/apps/nexus-ide')).toBe(true);
  });

  it.each([
    ['a space (Área de Trabalho)', '/home/u/Área de Trabalho/NexusIDE-linux-x64/nexus-ide'],
    ['a percent', '/home/u/100%/nexus-ide'],
    ['a dollar', '/home/u/$apps/nexus-ide'],
    ['parentheses', '/home/u/NexusIDE (1)/nexus-ide'],
  ])('routes a path with %s through a plain-named symlink', (_name, execPath) => {
    expect(isPlainDesktopExecPath(execPath)).toBe(false);
    expect(desktopExecToken(execPath, LINK)).toEqual({
      exec: LINK,
      link: { path: LINK, target: execPath },
    });
  });

  it('falls back to the quoted form when even the link path is not plain', () => {
    expect(desktopExecToken('/home/u/Meus Apps/nexus-ide', '/home/u u/.local/share/nexus-ide/nexus-ide')).toEqual({
      exec: '"/home/u/Meus Apps/nexus-ide"',
    });
  });

  it('refuses a path with control characters', () => {
    expect(desktopExecToken('/a/b\nExec=evil', LINK)).toBeNull();
  });
});

describe('buildPortableDesktopEntry', () => {
  it('declares the nexus:// handler, the icon and the ownership marker', () => {
    const entry = buildPortableDesktopEntry({
      exec: PORTABLE_EXEC,
      iconPath: '/home/u/apps/NexusIDE-linux-x64/resources/icon.png',
    });
    const lines = entry.split('\n');
    expect(lines[0]).toBe('[Desktop Entry]');
    expect(lines).toContain(`Exec=${PORTABLE_EXEC} %U`);
    expect(lines).toContain('Icon=/home/u/apps/NexusIDE-linux-x64/resources/icon.png');
    expect(lines).toContain('MimeType=x-scheme-handler/nexus;');
    expect(lines).toContain('StartupWMClass=nexus-ide');
    expect(lines).toContain('Categories=Development;');
    expect(lines).toContain(LINUX_PORTABLE_MARKER);
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('falls back to the themed icon name when no icon file is available', () => {
    expect(buildPortableDesktopEntry({ exec: PORTABLE_EXEC }).split('\n')).toContain(
      'Icon=nexus-ide',
    );
  });

  it('cannot be turned into a second key by a hostile icon path', () => {
    const entry = buildPortableDesktopEntry({
      exec: PORTABLE_EXEC,
      iconPath: '/a/icon.png\nExec=evil',
    });
    expect(entry.split('\n').filter((line) => line.startsWith('Exec='))).toHaveLength(1);
    expect(entry.split('\n')).toContain('Icon=nexus-ide');
  });
});

describe('planLinuxDesktopEntry', () => {
  it('writes the user entry for a portable build with no entry anywhere', () => {
    const plan = planLinuxDesktopEntry(input());
    expect(plan.action).toBe('write');
    if (plan.action !== 'write') return;
    expect(plan.file).toBe(USER_FILE);
    expect(plan.content).toContain(`Exec=${PORTABLE_EXEC} %U`);
    expect(plan.link).toBeUndefined();
  });

  it('adds a launcher symlink when the portable folder has a space in its path', () => {
    const execPath = '/home/u/Área de Trabalho/NexusIDE-linux-x64/nexus-ide';
    const link = linuxLauncherLinkPath(HOME, {});
    expect(link).toBe('/home/u/.local/share/nexus-ide/nexus-ide');
    const plan = planLinuxDesktopEntry(input({ execPath }));
    if (plan.action !== 'write') throw new Error('expected write');
    expect(plan.content).toContain(`Exec=${link} %U`);
    expect(plan.link).toEqual({ path: link, target: execPath });

    // Entrada e link em dia: nada a fazer.
    expect(
      planLinuxDesktopEntry(
        input({ execPath, readEntry: () => plan.content, readLink: () => execPath }),
      ),
    ).toEqual({ action: 'none', reason: 'up-to-date' });

    // A pasta mudou de lugar: a entrada não muda, só o link é refeito.
    const moved = planLinuxDesktopEntry(
      input({ execPath, readEntry: () => plan.content, readLink: () => '/old/place/nexus-ide' }),
    );
    expect(moved).toMatchObject({ action: 'write', link: { path: link, target: execPath } });
  });

  it('never replaces a real file sitting where the launcher link would go', () => {
    const execPath = '/home/u/Meus Apps/nexus-ide';
    const plan = planLinuxDesktopEntry(input({ execPath, readLink: () => undefined }));
    if (plan.action !== 'write') throw new Error('expected write');
    expect(plan.link).toBeUndefined();
    expect(plan.content).toContain('Exec="/home/u/Meus Apps/nexus-ide" %U');
  });

  it('honours an absolute XDG_DATA_HOME and ignores a relative one', () => {
    expect(linuxUserDesktopEntryPath(HOME, { XDG_DATA_HOME: '/data/u' })).toBe(
      '/data/u/applications/nexus-ide.desktop',
    );
    expect(linuxUserDesktopEntryPath(HOME, { XDG_DATA_HOME: 'relative' })).toBe(USER_FILE);
  });

  it.each([
    ['other platforms', { platform: 'darwin' as const }, 'not-linux'],
    ['development runs', { isPackaged: false }, 'not-packaged'],
    ['the packaged smoke', { automatedTest: true }, 'automated-test'],
    ['a relative home', { homeDir: 'home' }, 'no-home'],
  ])('does nothing for %s', (_name, overrides, reason) => {
    expect(planLinuxDesktopEntry(input(overrides))).toEqual({ action: 'none', reason });
  });

  it('is idempotent once the entry is current', () => {
    const first = planLinuxDesktopEntry(input());
    if (first.action !== 'write') throw new Error('expected write');
    expect(planLinuxDesktopEntry(input({ readEntry: () => first.content }))).toEqual({
      action: 'none',
      reason: 'up-to-date',
    });
  });

  it('rewrites its own entry when the portable folder moved', () => {
    const old = buildPortableDesktopEntry({ exec: '/old/place/nexus-ide' });
    const plan = planLinuxDesktopEntry(input({ readEntry: () => old }));
    expect(plan.action).toBe('write');
  });

  it('never overwrites an entry the operator wrote by hand', () => {
    const handmade = '[Desktop Entry]\nName=Meu Nexus\nExec=/x/nexus-ide %U\n';
    expect(planLinuxDesktopEntry(input({ readEntry: () => handmade }))).toEqual({
      action: 'none',
      reason: 'user-entry-present',
    });
  });

  it('treats an entry it cannot read as the user\'s, never as absent (review 02/10)', () => {
    // `undefined` = existe mas não é arquivo comum pequeno: symlink de dotfiles
    // (stow, chezmoi, home-manager), FIFO, arquivo enorme, sem permissão.
    expect(planLinuxDesktopEntry(input({ readEntry: () => undefined }))).toEqual({
      action: 'none',
      reason: 'user-entry-present',
    });
  });

  it('keeps an unreadable user entry even when a system entry exists', () => {
    expect(
      planLinuxDesktopEntry(
        input({
          execPath: '/usr/lib/nexus-ide/nexus-ide',
          readEntry: () => undefined,
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({ action: 'none', reason: 'system-entry-present' });
  });

  it('leaves the package manager entry alone on DEB/RPM installs', () => {
    expect(
      planLinuxDesktopEntry(
        input({
          execPath: '/usr/lib/nexus-ide/nexus-ide',
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({ action: 'none', reason: 'system-entry-present' });
  });

  it('finds the system entry even when XDG_DATA_DIRS omits /usr/share', () => {
    expect(
      planLinuxDesktopEntry(
        input({
          env: { XDG_DATA_DIRS: '/var/lib/flatpak/exports/share' },
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({ action: 'none', reason: 'system-entry-present' });
  });

  it('removes a stale portable entry that would shadow the installed package', () => {
    const stale = buildPortableDesktopEntry({ exec: '/old/place/nexus-ide' });
    expect(
      planLinuxDesktopEntry(
        input({
          execPath: '/usr/lib/nexus-ide/nexus-ide',
          readEntry: () => stale,
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({
      action: 'remove',
      file: USER_FILE,
      link: '/home/u/.local/share/nexus-ide/nexus-ide',
    });
  });

  it('keeps a hand-made user entry even on a package install', () => {
    expect(
      planLinuxDesktopEntry(
        input({
          execPath: '/usr/lib/nexus-ide/nexus-ide',
          readEntry: () => '[Desktop Entry]\nName=Meu Nexus\n',
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({ action: 'none', reason: 'system-entry-present' });
  });

  it('still registers a ZIP extracted under /usr/local or /usr/share (review 02/10)', () => {
    // `/usr/` inteiro era "gerenciado por pacote": quem extrai o ZIP em
    // /usr/local/nexus e tem o DEB instalado perdia a própria entrada.
    for (const execPath of ['/usr/local/nexus/nexus-ide', '/usr/local/lib/nexus-ide/nexus-ide', '/usr/share/nexus/nexus-ide', '/usr/bin/nexus-ide']) {
      expect(isPackageManagedExecutable(execPath), execPath).toBe(false);
    }
    const stale = buildPortableDesktopEntry({ exec: '/usr/local/nexus/nexus-ide' });
    expect(
      planLinuxDesktopEntry(
        input({
          execPath: '/usr/local/nexus/nexus-ide',
          readEntry: () => stale,
          entryExists: (file) => file === SYSTEM_FILE,
        }),
      ),
    ).toEqual({ action: 'none', reason: 'system-entry-present' });
  });

  it('still registers a ZIP extracted under /opt', () => {
    expect(isPackageManagedExecutable('/opt/NexusIDE-linux-x64/nexus-ide')).toBe(false);
    expect(isPackageManagedExecutable('/usr/lib64/nexus-ide/nexus-ide')).toBe(true);
    expect(planLinuxDesktopEntry(input({ execPath: '/opt/NexusIDE-linux-x64/nexus-ide' })).action).toBe(
      'write',
    );
  });
});

describe('MIME index (F-740)', () => {
  const OURS = 'x-scheme-handler/nexus=nexus-ide.desktop;';

  it('recognises the handler only inside the MIME Cache group', () => {
    expect(mimeCacheListsHandler(`[MIME Cache]\n${OURS}\n`)).toBe(true);
    expect(mimeCacheListsHandler('[MIME Cache]\nx-scheme-handler/nexus=other.desktop;nexus-ide.desktop;\n')).toBe(true);
    expect(mimeCacheListsHandler(null)).toBe(false);
    expect(mimeCacheListsHandler('')).toBe(false);
    expect(mimeCacheListsHandler(`[Other]\n${OURS}\n`)).toBe(false);
    expect(mimeCacheListsHandler('[MIME Cache]\nx-scheme-handler/nexus=other.desktop;\n')).toBe(false);
    // O Nexus Shot tem o próprio esquema; não vale pelo do IDE.
    expect(mimeCacheListsHandler('[MIME Cache]\nx-scheme-handler/nexus-shot=nexus-ide.desktop;\n')).toBe(false);
  });

  it('merges our line without touching anyone else', () => {
    expect(mergeMimeCacheHandler(null)).toBe(`[MIME Cache]\n${OURS}\n`);
    expect(mergeMimeCacheHandler('')).toBe(`[MIME Cache]\n${OURS}\n`);
    expect(mergeMimeCacheHandler('[MIME Cache]\ntext/html=a.desktop;\n')).toBe(
      `[MIME Cache]\ntext/html=a.desktop;\n${OURS}\n`,
    );
    expect(mergeMimeCacheHandler('[MIME Cache]\nx-scheme-handler/nexus=other.desktop;\n')).toBe(
      '[MIME Cache]\nx-scheme-handler/nexus=nexus-ide.desktop;other.desktop;\n',
    );
    expect(mergeMimeCacheHandler('[Other]\nk=v\n')).toBe(`[Other]\nk=v\n[MIME Cache]\n${OURS}\n`);
    expect(mergeMimeCacheHandler('[MIME Cache]\ntext/html=a.desktop;\n[Other]\nk=v\n')).toBe(
      `[MIME Cache]\ntext/html=a.desktop;\n${OURS}\n[Other]\nk=v\n`,
    );
    for (const input of [null, '[MIME Cache]\ntext/html=a.desktop;\n', '[Other]\nk=v\n']) {
      expect(mimeCacheListsHandler(mergeMimeCacheHandler(input))).toBe(true);
    }
  });

  function deps(initial: string | null, toolWrites: string | null) {
    const state = { cache: initial, toolRuns: 0, writes: 0 };
    return {
      state,
      deps: {
        readCache: () => state.cache,
        runUpdateDesktopDatabase: () => {
          state.toolRuns += 1;
          if (toolWrites === null) return false;
          state.cache = toolWrites;
          return true;
        },
        writeCache: (_file: string, content: string) => {
          state.writes += 1;
          state.cache = content;
        },
      },
    };
  }

  it('does nothing when the index already lists the handler', () => {
    const { state, deps: d } = deps(`[MIME Cache]\n${OURS}\n`, null);
    expect(ensureMimeIndex('/home/u/.local/share/applications', d)).toBe('already-listed');
    expect(state).toMatchObject({ toolRuns: 0, writes: 0 });
  });

  it('prefers the system tool and trusts it only if the line really appeared', () => {
    const ok = deps(null, `[MIME Cache]\n${OURS}\n`);
    expect(ensureMimeIndex('/home/u/.local/share/applications', ok.deps)).toBe('updated');
    expect(ok.state).toMatchObject({ toolRuns: 1, writes: 0 });

    // A ferramenta rodou "com sucesso" mas não registrou (entrada inválida para
    // ela, versão antiga…): a mescla garante a linha.
    const silent = deps(null, '[MIME Cache]\ntext/html=a.desktop;\n');
    expect(ensureMimeIndex('/home/u/.local/share/applications', silent.deps)).toBe('merged');
    expect(mimeCacheListsHandler(silent.state.cache)).toBe(true);
    expect(silent.state.cache).toContain('text/html=a.desktop;');
  });

  it('does nothing when the index exists but is not a plain file we may rewrite', () => {
    const state = { toolRuns: 0, writes: 0 };
    const outcome = ensureMimeIndex('/home/u/.local/share/applications', {
      readCache: () => undefined,
      runUpdateDesktopDatabase: () => {
        state.toolRuns += 1;
        return true;
      },
      writeCache: () => {
        state.writes += 1;
      },
    });
    expect(outcome).toBe('skipped');
    expect(state).toEqual({ toolRuns: 0, writes: 0 });
  });

  it('falls back to the merge when the tool is not installed', () => {
    const { state, deps: d } = deps(null, null);
    expect(ensureMimeIndex('/home/u/.local/share/applications', d)).toBe('merged');
    expect(state).toMatchObject({ toolRuns: 1, writes: 1 });
    expect(state.cache).toBe(`[MIME Cache]\n${OURS}\n`);
  });
});

describe('resolveLinuxRuntimeIconPath', () => {
  const context = {
    platform: 'linux' as const,
    isPackaged: true,
    resourcesPath: '/opt/NexusIDE/resources',
    appPath: '/src/nexus-ide',
  };

  it('uses the packaged resource, or the repository asset in development', () => {
    expect(resolveLinuxRuntimeIconPath(context, () => true)).toBe(
      '/opt/NexusIDE/resources/icon.png',
    );
    expect(resolveLinuxRuntimeIconPath({ ...context, isPackaged: false }, () => true)).toBe(
      '/src/nexus-ide/assets/icon.png',
    );
  });

  it('is undefined off Linux or when the file is missing', () => {
    expect(resolveLinuxRuntimeIconPath({ ...context, platform: 'win32' }, () => true)).toBeUndefined();
    expect(resolveLinuxRuntimeIconPath(context, () => false)).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('ensureLinuxDesktopEntry (filesystem)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function sandbox(): { home: string; file: string; options: Parameters<typeof ensureLinuxDesktopEntry>[0] } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-desktop-entry-')));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    return {
      home,
      file: path.join(home, '.local', 'share', 'applications', LINUX_DESKTOP_FILE_NAME),
      options: {
        platform: 'linux',
        isPackaged: true,
        automatedTest: false,
        execPath: path.join(root, 'NexusIDE-linux-x64', 'nexus-ide'),
        resourcesPath: path.join(root, 'NexusIDE-linux-x64', 'resources'),
        appPath: root,
        homeDir: home,
        // Sem entrada de sistema visível: o teste não depende da máquina.
        env: { XDG_DATA_DIRS: path.join(root, 'no-system-data') },
        // Sem a ferramenta do sistema: o caminho de mescla é o determinístico.
        mimeIndex: {
          readCache: (target: string) => {
            try {
              return fs.readFileSync(target, 'utf8');
            } catch {
              return null;
            }
          },
          runUpdateDesktopDatabase: () => false,
          writeCache: (target: string, content: string) => fs.writeFileSync(target, content),
        },
      },
    };
  }

  // `/usr/share` é sempre consultado; numa máquina com o DEB instalado o plano
  // real é "system-entry-present" e estes casos não se aplicam.
  const systemInstalled = fs.existsSync(SYSTEM_FILE);

  it.skipIf(systemInstalled)('creates the entry atomically with user-only directories', () => {
    const { file, options } = sandbox();
    expect(ensureLinuxDesktopEntry(options).action).toBe('write');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('MimeType=x-scheme-handler/nexus;');
    expect(content).toContain(LINUX_PORTABLE_MARKER);
    // Só a entrada e o índice de tipos: nenhum temporário fica para trás.
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['mimeinfo.cache', LINUX_DESKTOP_FILE_NAME]);
    expect(ensureLinuxDesktopEntry(options)).toEqual({ action: 'none', reason: 'up-to-date' });
  });

  it.skipIf(systemInstalled)('lists the handler in the MIME index the desktop portal reads (F-740)', () => {
    const { file, options } = sandbox();
    const cache = path.join(path.dirname(file), 'mimeinfo.cache');
    ensureLinuxDesktopEntry(options);
    expect(fs.readFileSync(cache, 'utf8')).toBe(
      '[MIME Cache]\nx-scheme-handler/nexus=nexus-ide.desktop;\n',
    );

    // Outro app regenerou o índice sem a nossa linha (foi o que aconteceu no
    // Omarchy): o próximo boot cura, com a entrada já em dia.
    fs.writeFileSync(cache, '[MIME Cache]\ntext/html=browser.desktop;\n');
    expect(ensureLinuxDesktopEntry(options)).toEqual({ action: 'none', reason: 'up-to-date' });
    expect(fs.readFileSync(cache, 'utf8')).toBe(
      '[MIME Cache]\ntext/html=browser.desktop;\nx-scheme-handler/nexus=nexus-ide.desktop;\n',
    );
  });

  it.skipIf(systemInstalled)('never writes through a symlink at the entry path, and does not replace it either', () => {
    const { home, file, options } = sandbox();
    const victim = path.join(home, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(victim, file);
    // Um symlink existe: é do operador (dotfiles) ou foi plantado. Nos dois casos
    // o app não escreve através dele nem o troca por uma entrada própria.
    expect(ensureLinuxDesktopEntry(options)).toEqual({ action: 'none', reason: 'user-entry-present' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it.skipIf(systemInstalled)('creates and repoints the launcher symlink for a path with spaces', () => {
    const { home, file, options } = sandbox();
    const spaced = path.join(path.dirname(path.dirname(options.execPath)), 'Área de Trabalho', 'nexus-ide');
    const link = path.join(home, '.local', 'share', 'nexus-ide', 'nexus-ide');
    expect(ensureLinuxDesktopEntry({ ...options, execPath: spaced }).action).toBe('write');
    expect(fs.readlinkSync(link)).toBe(spaced);
    expect(fs.readFileSync(file, 'utf8')).toContain(`Exec=${link} %U`);
    expect(ensureLinuxDesktopEntry({ ...options, execPath: spaced })).toEqual({
      action: 'none',
      reason: 'up-to-date',
    });
    const moved = `${spaced} 2`;
    expect(ensureLinuxDesktopEntry({ ...options, execPath: moved }).action).toBe('write');
    expect(fs.readlinkSync(link)).toBe(moved);
  });

  it.skipIf(systemInstalled)('does not replace a dotfile-managed symlink with its own entry (review 02/10)', () => {
    const { home, file, options } = sandbox();
    const managed = path.join(home, 'dotfiles', 'nexus-ide.desktop');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '[Desktop Entry]\nName=Meu Nexus\nExec=/x/nexus-ide %U\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(managed, file);

    expect(ensureLinuxDesktopEntry(options)).toEqual({ action: 'none', reason: 'user-entry-present' });

    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(managed, 'utf8')).toContain('Name=Meu Nexus');
  });

  it.skipIf(systemInstalled)('leaves a symlinked MIME index alone instead of rewriting it', () => {
    const { home, file, options } = sandbox();
    const managed = path.join(home, 'dotfiles', 'mimeinfo.cache');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '[MIME Cache]\ntext/html=a.desktop;\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(managed, path.join(path.dirname(file), 'mimeinfo.cache'));
    // O cache do teste lê com readFileSync (segue o link); o padrão do app não.
    const real = options.mimeIndex;
    expect(real).toBeDefined();
    ensureLinuxDesktopEntry({
      ...options,
      mimeIndex: { ...real!, readCache: () => undefined },
    });
    expect(fs.lstatSync(path.join(path.dirname(file), 'mimeinfo.cache')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(managed, 'utf8')).toBe('[MIME Cache]\ntext/html=a.desktop;\n');
  });

  it('never throws when the applications directory cannot be created', () => {
    const { home, options } = sandbox();
    fs.writeFileSync(path.join(home, '.local'), 'not a directory');
    const plan = ensureLinuxDesktopEntry(options);
    expect(plan.action).toBe('none');
  });
});
