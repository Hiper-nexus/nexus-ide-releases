import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDLINE_SNAPSHOT_FILENAME } from '../../shared/redline-types';
import { omarchyShellConfigPath, stableStringify } from './redline-bar-config';
import {
  findOnPath,
  parseRedlineAppOption,
  parseRedlineCliArgs,
  redlineBarSnippets,
  requestShellReload,
  resolveAppExecutable,
  runRedlineCli,
  validateAppOption,
  type RedlineCliDeps,
} from './redline-cli';

const NOW = 1_780_000_000_000;
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function tmpHome(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-')));
  roots.push(root);
  return root;
}

function snapshotJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: NOW,
    worstUsedRatio: 0.87,
    entries: [
      {
        id: 'codex:a',
        adapterId: 'codex',
        label: 'Codex',
        active: false,
        installed: true,
        onCooldown: false,
        windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.87 }],
        updatedAt: NOW,
        eligible: true,
      },
    ],
    ranking: {},
    statusBarEntryIds: ['codex:a'],
    ...overrides,
  });
}

function writeSnapshot(home: string, text: string): string {
  const file = path.join(home, '.nexus', REDLINE_SNAPSHOT_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function makeDeps(home: string, overrides: Partial<RedlineCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const reload = vi.fn(() => true);
  const deps: RedlineCliDeps = {
    homedir: home,
    env: { OMARCHY_PATH: path.join(home, 'sem-omarchy') },
    execPath: '/opt/nexus/nexus-ide',
    now: () => NOW,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    reloadShell: reload,
    resolvePath: (file) => file,
    ...overrides,
  };
  return { deps, out, err, reload };
}

describe('parseRedlineCliArgs', () => {
  it('reconhece só a igualdade exata das quatro flags', () => {
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--redline-status'])).toBe('status');
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--redline-bar-install'])).toBe('install');
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--redline-bar-uninstall'])).toBe('uninstall');
    expect(parseRedlineCliArgs(['electron', 'main.js', '--redline-bar-snippet'])).toBe('snippet');
  });

  it('launch normal, deep link e prefixos parecidos não disparam nada', () => {
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide'])).toBeNull();
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', 'nexus://quota'])).toBeNull();
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--redline-status=1'])).toBeNull();
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--redline-statuss'])).toBeNull();
    expect(parseRedlineCliArgs(['/usr/bin/nexus-ide', '--constructor'])).toBeNull();
    expect(parseRedlineCliArgs(['--redline-status'])).toBeNull(); // argv[0] é o executável
  });
});

describe('--redline-status', () => {
  it('lê o snapshot do home e imprime UMA linha de JSON no formato do Waybar/Omarchy', () => {
    const home = tmpHome();
    writeSnapshot(home, snapshotJson());
    const { deps, out, err } = makeDeps(home);

    expect(runRedlineCli('status', deps)).toBe(0);

    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0].endsWith('\n')).toBe(true);
    expect(out[0].trimEnd().split('\n')).toHaveLength(1);
    const json = JSON.parse(out[0]) as { text: string; percentage: number; class: string[]; tooltip: string };
    expect(json.text).toBe('▮▮▮▮▯ 87%');
    expect(json.percentage).toBe(87);
    expect(json.class).toEqual(['nexus-redline', 'danger', 'active']);
    expect(json.tooltip).toContain('87%');
  });

  it('sem arquivo: saída neutra e código 0 (a barra nunca pode ficar quebrada)', () => {
    const { deps, out } = makeDeps(tmpHome());
    expect(runRedlineCli('status', deps)).toBe(0);
    const json = JSON.parse(out[0]) as { text: string; percentage?: number };
    expect(json.text).toBe('Redline —');
    expect(json).not.toHaveProperty('percentage');
  });

  it('arquivo inválido, de outra versão ou acima do teto: nunca confia e nunca lança', () => {
    for (const content of ['{ "isto": não é json', snapshotJson({ formatVersion: 2 }), 'x'.repeat(1024 * 1024 + 1)]) {
      const home = tmpHome();
      writeSnapshot(home, content);
      const { deps, out } = makeDeps(home);
      expect(runRedlineCli('status', deps)).toBe(0);
      expect((JSON.parse(out[0]) as { text: string }).text).toBe('Redline —');
    }
  });

  it('um FIFO no lugar do snapshot não pendura a leitura', () => {
    const home = tmpHome();
    const file = path.join(home, '.nexus', REDLINE_SNAPSHOT_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      execFileSync('mkfifo', [file]);
    } catch {
      return; // sem mkfifo neste ambiente
    }
    const { deps, out } = makeDeps(home);
    expect(runRedlineCli('status', deps)).toBe(0);
    expect((JSON.parse(out[0]) as { text: string }).text).toBe('Redline —');
  });

  it('e-mail inteiro que escapou para o snapshot sai mascarado, nunca inteiro', () => {
    const home = tmpHome();
    const entry = JSON.parse(snapshotJson()).entries[0] as Record<string, unknown>;
    writeSnapshot(home, snapshotJson({ entries: [{ ...entry, label: 'maria.silva@example.com', emailMasked: 'ma***@ex***.com' }] }));
    const { deps, out } = makeDeps(home);
    runRedlineCli('status', deps);
    expect(out[0]).not.toContain('maria.silva@example.com');
  });

  it('erro inesperado vira JSON neutro, não pilha', () => {
    const { deps, out, err } = makeDeps(tmpHome(), {
      now: () => {
        throw new Error('relógio quebrado');
      },
    });
    expect(runRedlineCli('status', deps)).toBe(0);
    expect(err).toEqual([]);
    expect((JSON.parse(out[0]) as { tooltip: string }).tooltip).toContain('indisponível');
  });
});

describe('resolveAppExecutable', () => {
  const base = { homedir: '/home/op', execPath: '/home/op/.local/share/nexus-ide/nexus-ide' };

  it('prefere o atalho estável quando ele aponta para este binário', () => {
    const real = '/home/op/.local/share/nexus-ide/nexus-ide';
    const resolvePath = (file: string) =>
      file === '/home/op/.local/bin/nexus-ide' || file === base.execPath ? real : null;
    expect(resolveAppExecutable({ ...base, resolvePath })).toBe('/home/op/.local/bin/nexus-ide');
  });

  it('atalho que aponta para OUTRA instalação não é usado', () => {
    const resolvePath = (file: string) =>
      file === '/home/op/.local/bin/nexus-ide' ? '/outra/instalacao/nexus-ide' : file === '/usr/bin/nexus-ide' ? null : file;
    expect(resolveAppExecutable({ ...base, resolvePath })).toBe(base.execPath);
  });

  it('pacote DEB/RPM: /usr/bin/nexus-ide apontando para o binário de /usr/lib', () => {
    const real = '/usr/lib/nexus-ide/nexus-ide';
    const resolvePath = (file: string) => (file === '/usr/bin/nexus-ide' || file === real ? real : null);
    expect(resolveAppExecutable({ homedir: '/home/op', execPath: real, resolvePath })).toBe('/usr/bin/nexus-ide');
  });
});

describe('--redline-bar-snippet', () => {
  it('imprime os dois trechos sem gravar nada', () => {
    const home = tmpHome();
    const { deps, out } = makeDeps(home);
    expect(runRedlineCli('snippet', deps)).toBe(0);
    const text = out.join('');
    expect(text).toContain('"id": "nexus-redline"');
    expect(text).toContain('"type": "command"');
    expect(text).toContain('custom/nexus-redline');
    expect(text).toContain('"return-type": "json"');
    expect(text).toContain("'/opt/nexus/nexus-ide' --redline-status");
    expect(fs.existsSync(path.join(home, '.config'))).toBe(false);
  });

  it('o trecho do Waybar é JSON válido quando sozinho', () => {
    const text = redlineBarSnippets('/usr/bin/nexus-ide');
    const start = text.indexOf('{\n  "custom/nexus-redline"');
    const end = text.indexOf('\n}', start) + 2;
    const parsed = JSON.parse(text.slice(start, end)) as Record<string, { interval: number }>;
    expect(parsed['custom/nexus-redline'].interval).toBe(30);
  });
});

describe('--redline-bar-install / --redline-bar-uninstall', () => {
  const OWNER = { bar: { layout: { left: [], center: [], right: [{ id: 'omarchy.tray' }, { id: 'omarchy.audio' }] } }, plugins: [], version: 1 };

  it('instala, mostra o backup e como desfazer, e pede ao shell que recarregue', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stableStringify(OWNER));
    const { deps, out, err, reload } = makeDeps(home);

    expect(runRedlineCli('install', deps)).toBe(0);

    const text = out.join('');
    expect(text).toContain('Redline adicionado à barra do Omarchy');
    expect(text).toContain('Backup:');
    expect(text).toContain('Para desfazer: cp ');
    expect(text).toContain('omarchy-shell shell reloadConfig');
    expect(err).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('--redline-status');
  });

  it('recusa com código 1 e mensagem em stderr quando o shell.json é inválido', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ quebrado');
    const { deps, out, err } = makeDeps(home);

    expect(runRedlineCli('install', deps)).toBe(1);

    expect(out).toEqual([]);
    expect(err.join('')).toContain('não é um JSON válido');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ quebrado');
  });

  it('avisa quando o shell não respondeu ao reload, sem falhar a instalação', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stableStringify(OWNER));
    const { deps, out } = makeDeps(home, { reloadShell: () => false });
    expect(runRedlineCli('install', deps)).toBe(0);
    expect(out.join('')).toContain('Não consegui avisar o shell');
  });

  it('desinstala e, sem o módulo, diz que não estava instalado com código 0', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stableStringify(OWNER));
    runRedlineCli('install', makeDeps(home).deps);

    const removed = makeDeps(home);
    expect(runRedlineCli('uninstall', removed.deps)).toBe(0);
    expect(removed.out.join('')).toContain('Redline removido da barra do Omarchy');

    const again = makeDeps(home);
    expect(runRedlineCli('uninstall', again.deps)).toBe(0);
    expect(again.out.join('')).toContain('não estava na barra');
  });
});

describe('recarregar o shell sem processo síncrono', () => {
  function fakeBin(dir: string, name: string, script: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, script, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return file;
  }

  it('findOnPath só devolve executável de verdade e ignora entradas vazias', () => {
    const dir = tmpHome();
    const bin = fakeBin(dir, 'omarchy-shell', '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(dir, 'nao-executavel'), 'x', { mode: 0o644 });
    expect(findOnPath('omarchy-shell', `::${dir}`)).toBe(bin);
    expect(findOnPath('nao-executavel', dir)).toBeNull();
    expect(findOnPath('omarchy-shell', '')).toBeNull();
  });

  it('sem omarchy-shell no PATH devolve false e não lança', () => {
    expect(requestShellReload(tmpHome())).toBe(false);
  });

  it('com omarchy-shell no PATH dispara `shell reloadConfig` solto e devolve true', async () => {
    const dir = tmpHome();
    const marker = path.join(dir, 'chamado.txt');
    fakeBin(dir, 'omarchy-shell', `#!/bin/sh\nprintf '%s ' "$@" > '${marker}'\n`);

    expect(requestShellReload(dir)).toBe(true);

    for (let i = 0; i < 40 && !fs.existsSync(marker); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('shell reloadConfig');
  });
});

describe('--app <caminho>', () => {
  it('lê o valor logo depois de --app e distingue ausente de vazio', () => {
    expect(parseRedlineAppOption(['/x/nexus-ide', '--redline-bar-install', '--app', '/opt/n/nexus-ide'])).toBe('/opt/n/nexus-ide');
    expect(parseRedlineAppOption(['/x/nexus-ide', '--redline-bar-install'])).toBeNull();
    expect(parseRedlineAppOption(['/x/nexus-ide', '--redline-bar-install', '--app'])).toBe('');
  });

  it('só aceita caminho absoluto, sem controle, que exista e execute', () => {
    const ok = { resolvePath: (f: string) => f, isExecutable: () => true };
    expect(validateAppOption('/opt/n/nexus-ide', ok)).toBeNull();
    expect(validateAppOption('relativo/nexus-ide', ok)).toContain('caminho absoluto');
    expect(validateAppOption('', ok)).toContain('caminho absoluto');
    expect(validateAppOption('/opt/n\n/nexus-ide', ok)).toContain('caminho absoluto');
    expect(validateAppOption('/nao/existe', { resolvePath: () => null, isExecutable: () => true })).toContain('não existe');
    expect(validateAppOption('/sem/permissao', { resolvePath: (f) => f, isExecutable: () => false })).toContain('não é executável');
  });

  it('o instalador grava o executável pedido, com aspas, em vez do descoberto', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stableStringify({ bar: { layout: { right: [{ id: 'omarchy.tray' }] } } }));
    const { deps, out } = makeDeps(home, { appOption: '/opt/Meu App/nexus-ide', isExecutable: () => true });
    expect(runRedlineCli('install', deps)).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain("'/opt/Meu App/nexus-ide' --redline-status");
    expect(out.join('')).toContain('Redline adicionado');
  });

  it('--app inválido recusa com código 1 e não grava nada', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = stableStringify({ bar: { layout: { right: [] } } });
    fs.writeFileSync(file, original);
    const { deps, err } = makeDeps(home, { appOption: 'relativo' });
    expect(runRedlineCli('install', deps)).toBe(1);
    expect(err.join('')).toContain('caminho absoluto');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('o comando roda antes do resto do Main', () => {
  it("o primeiro import de main.ts é o redline-cli-boot (senão a barra abriria o Nexus inteiro)", () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    const firstImport = source.split('\n').find((line) => /^\s*import\s/.test(line));
    expect(firstImport).toBe("import './redline/redline-cli-boot';");
  });

  it('o boot só chama o comando, sem importar mais nada do app', () => {
    const boot = fs.readFileSync(path.join(__dirname, 'redline-cli-boot.ts'), 'utf8');
    const imports = boot.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports).toEqual(["import { runRedlineCliFromProcess } from './redline-cli';"]);
  });
});
