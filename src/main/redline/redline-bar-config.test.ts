import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REDLINE_BAR_MODULE_ID,
  applyRedlineBarEntry,
  installRedlineBar,
  normalizeShellConfig,
  omarchyShellConfigPath,
  redlineBarEntry,
  removeRedlineBarEntry,
  shellQuote,
  stableStringify,
  uninstallRedlineBar,
} from './redline-bar-config';

const APP = '/home/op/.local/bin/nexus-ide';
const NOW = 1_780_000_000_000;

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

function tmpHome(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redline-bar-')));
  roots.push(root);
  return root;
}

const OWNER_CONFIG = {
  bar: {
    centerAnchor: 'omarchy.clock',
    layout: {
      center: [{ id: 'omarchy.clock', format: 'HH:mm' }],
      left: [{ id: 'omarchy.menu' }],
      right: [{ id: 'omarchy.tray' }, { id: 'omarchy.audio' }, { id: 'omarchy.power' }],
    },
    position: 'top',
  },
  idle: { lock: 300 },
  plugins: [{ id: 'omadock' }],
  version: 1,
};

function writeConfig(home: string, value: unknown, mode = 0o644): string {
  const file = omarchyShellConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : stableStringify(value), { mode });
  fs.chmodSync(file, mode);
  return file;
}

function deps(home: string, reload = vi.fn(() => true)) {
  return { deps: { homedir: home, env: { OMARCHY_PATH: path.join(home, 'no-omarchy') }, now: () => NOW, reloadShell: reload }, reload };
}

function rightIds(config: { bar: { layout: { right: Array<string | { id: string }> } } }): string[] {
  return config.bar.layout.right.map((entry) => (typeof entry === 'string' ? entry : entry.id));
}

describe('helpers puros', () => {
  it('stableStringify ordena as chaves, usa 2 espaços e termina com quebra de linha', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } })).toBe(
      '{\n  "a": {\n    "c": 0,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('shellQuote protege espaço e aspas simples do caminho do app', () => {
    expect(shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(shellQuote("/o'neil/nexus-ide")).toBe("'/o'\\''neil/nexus-ide'");
  });

  it('o módulo executa o app com --redline-status e abre as cotas no clique', () => {
    const entry = redlineBarEntry('/opt/Nexus IDE/nexus-ide');
    expect(entry).toMatchObject({
      id: REDLINE_BAR_MODULE_ID,
      type: 'command',
      exec: "'/opt/Nexus IDE/nexus-ide' --redline-status",
      interval: 30,
      onClick: 'xdg-open nexus://quota',
    });
  });

  it('normalizeShellConfig completa a estrutura sem perder o resto', () => {
    const config = normalizeShellConfig({ idle: { lock: 1 }, bar: { position: 'top' } });
    expect(config).toMatchObject({
      version: 1,
      idle: { lock: 1 },
      bar: { position: 'top', layout: { left: [], center: [], right: [] } },
      plugins: [],
    });
    expect(normalizeShellConfig('lixo')).toMatchObject({ version: 1, plugins: [] });
  });

  it('entra logo depois da bandeja e preserva o que já estava na barra', () => {
    const { config, action } = applyRedlineBarEntry(OWNER_CONFIG, redlineBarEntry(APP));
    expect(action).toBe('added');
    expect(rightIds(config as never)).toEqual([
      'omarchy.tray',
      REDLINE_BAR_MODULE_ID,
      'omarchy.audio',
      'omarchy.power',
    ]);
    expect((config as typeof OWNER_CONFIG).bar.layout.left).toEqual(OWNER_CONFIG.bar.layout.left);
    expect((config as typeof OWNER_CONFIG).plugins).toEqual([{ id: 'omadock' }]);
    // o objeto de entrada NÃO foi alterado no lugar
    expect(OWNER_CONFIG.bar.layout.right).toHaveLength(3);
  });

  it('sem bandeja na barra, entra no começo da direita; sem barra nenhuma, cria a estrutura', () => {
    const noTray = applyRedlineBarEntry(
      { bar: { layout: { right: [{ id: 'omarchy.audio' }] } } },
      redlineBarEntry(APP),
    );
    expect(rightIds(noTray.config as never)).toEqual([REDLINE_BAR_MODULE_ID, 'omarchy.audio']);
    const empty = applyRedlineBarEntry({}, redlineBarEntry(APP));
    expect(rightIds(empty.config as never)).toEqual([REDLINE_BAR_MODULE_ID]);
  });

  it('é idempotente: aplicar duas vezes o mesmo comando não muda nada', () => {
    const first = applyRedlineBarEntry(OWNER_CONFIG, redlineBarEntry(APP));
    const second = applyRedlineBarEntry(first.config, redlineBarEntry(APP));
    expect(second.action).toBe('unchanged');
    expect(stableStringify(second.config)).toBe(stableStringify(first.config));
  });

  it('se o app mudou de lugar só o exec é corrigido; os ajustes do operador ficam', () => {
    const tuned = {
      bar: { layout: { right: [{ id: REDLINE_BAR_MODULE_ID, type: 'command', exec: 'velho', interval: 120, fontSize: 14, onClick: 'meu-comando' }] } },
    };
    const { config, action } = applyRedlineBarEntry(tuned, redlineBarEntry('/novo/nexus-ide'));
    expect(action).toBe('updated');
    const entry = (config as typeof tuned).bar.layout.right[0];
    expect(entry).toMatchObject({
      exec: "'/novo/nexus-ide' --redline-status",
      interval: 120,
      fontSize: 14,
      onClick: 'meu-comando',
      tooltip: 'Nexus Redline',
    });
  });

  it('entrada escrita só como texto (id solto) também é reconhecida e completada', () => {
    const { action, config } = applyRedlineBarEntry(
      { bar: { layout: { right: [REDLINE_BAR_MODULE_ID] } } },
      redlineBarEntry(APP),
    );
    expect(action).toBe('updated');
    expect(rightIds(config as never)).toEqual([REDLINE_BAR_MODULE_ID]);
  });

  it('remove de qualquer seção; ausente não é erro', () => {
    const added = applyRedlineBarEntry(OWNER_CONFIG, redlineBarEntry(APP)).config;
    const removed = removeRedlineBarEntry(added);
    expect(removed.action).toBe('removed');
    expect(rightIds(removed.config as never)).toEqual(['omarchy.tray', 'omarchy.audio', 'omarchy.power']);
    expect(removeRedlineBarEntry(OWNER_CONFIG).action).toBe('absent');
  });
});

describe('installRedlineBar / uninstallRedlineBar (arquivo de verdade)', () => {
  it('instala com backup do original, chaves ordenadas e pede ao shell que recarregue', () => {
    const home = tmpHome();
    const file = writeConfig(home, OWNER_CONFIG);
    const original = fs.readFileSync(file, 'utf8');
    const { deps: d, reload } = deps(home);

    const result = installRedlineBar(d, APP);

    expect(result.status).toBe('installed');
    expect(result.reloaded).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.backupPath).toBe(`${file}.bak.nexus-redline.${Math.floor(NOW / 1000)}`);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe(original);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof OWNER_CONFIG;
    expect(rightIds(written as never)).toContain(REDLINE_BAR_MODULE_ID);
    expect(fs.readFileSync(file, 'utf8')).toBe(stableStringify(written));
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('segunda instalação não muda o arquivo, não cria outro backup e não recarrega', () => {
    const home = tmpHome();
    const file = writeConfig(home, OWNER_CONFIG);
    const first = deps(home);
    installRedlineBar(first.deps, APP);
    const afterFirst = fs.readFileSync(file, 'utf8');
    const filesAfterFirst = fs.readdirSync(path.dirname(file)).sort();

    const second = deps(home);
    const result = installRedlineBar(second.deps, APP);

    expect(result.status).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
    expect(second.reload).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(filesAfterFirst);
  });

  it('mantém o modo do arquivo (0600 continua 0600)', () => {
    const home = tmpHome();
    const file = writeConfig(home, OWNER_CONFIG, 0o600);
    installRedlineBar(deps(home).deps, APP);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('shell.json que é link de dotfiles: o link continua link e o alvo é que muda', () => {
    const home = tmpHome();
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles, { recursive: true });
    const target = path.join(dotfiles, 'shell.json');
    fs.writeFileSync(target, stableStringify(OWNER_CONFIG));
    const link = omarchyShellConfigPath(home);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);

    const result = installRedlineBar(deps(home).deps, APP);

    expect(result.status).toBe('installed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toContain(REDLINE_BAR_MODULE_ID);
    expect(result.backupPath?.startsWith(dotfiles)).toBe(true);
  });

  it('JSON inválido: recusa, não grava, não faz backup e não recarrega', () => {
    const home = tmpHome();
    const file = writeConfig(home, '{ "bar": { oops');
    const { deps: d, reload } = deps(home);

    const result = installRedlineBar(d, APP);

    expect(result.status).toBe('refused');
    expect(result.message).toContain('não é um JSON válido');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "bar": { oops');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['shell.json']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('arquivo grande demais ou que não é comum: recusa sem tocar em nada', () => {
    const home = tmpHome();
    const file = omarchyShellConfigPath(home);
    fs.mkdirSync(file, { recursive: true }); // um DIRETÓRIO no lugar do arquivo
    const result = installRedlineBar(deps(home).deps, APP);
    expect(result.status).toBe('refused');
    expect(fs.statSync(file).isDirectory()).toBe(true);

    const big = tmpHome();
    writeConfig(big, ' '.repeat(1024 * 1024 + 5));
    expect(installRedlineBar(deps(big).deps, APP).status).toBe('refused');
  });

  it('sem shell.json parte da configuração padrão do Omarchy (como `omarchy bar put`)', () => {
    const home = tmpHome();
    const omarchy = path.join(home, 'omarchy');
    fs.mkdirSync(path.join(omarchy, 'config', 'omarchy'), { recursive: true });
    fs.writeFileSync(path.join(omarchy, 'config', 'omarchy', 'shell.json'), stableStringify(OWNER_CONFIG));
    const { deps: d } = deps(home);

    const result = installRedlineBar({ ...d, env: { OMARCHY_PATH: omarchy } }, APP);

    expect(result.status).toBe('installed');
    expect(result.backupPath).toBeUndefined();
    const written = JSON.parse(fs.readFileSync(omarchyShellConfigPath(home), 'utf8')) as typeof OWNER_CONFIG;
    expect(rightIds(written as never)).toEqual(['omarchy.tray', REDLINE_BAR_MODULE_ID, 'omarchy.audio', 'omarchy.power']);
    expect(written.bar.layout.left).toEqual(OWNER_CONFIG.bar.layout.left);
  });

  it('sem shell.json e sem o padrão do Omarchy: recusa e manda usar o trecho', () => {
    const home = tmpHome();
    const result = installRedlineBar(deps(home).deps, APP);
    expect(result.status).toBe('refused');
    expect(result.message).toContain('--redline-bar-snippet');
    expect(fs.existsSync(omarchyShellConfigPath(home))).toBe(false);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'sem permissão de escrita: recusa e o arquivo original continua como estava',
    () => {
      const home = tmpHome();
      const file = writeConfig(home, OWNER_CONFIG);
      const before = fs.readFileSync(file, 'utf8');
      fs.chmodSync(path.dirname(file), 0o500);
      const { deps: d, reload } = deps(home);

      const result = installRedlineBar(d, APP);

      fs.chmodSync(path.dirname(file), 0o700);
      expect(result.status).toBe('refused');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('desinstala com backup e deixa o resto igual; sem o módulo não mexe no arquivo', () => {
    const home = tmpHome();
    const file = writeConfig(home, OWNER_CONFIG);
    installRedlineBar(deps(home).deps, APP);
    const removed = uninstallRedlineBar(deps(home).deps);
    expect(removed.status).toBe('removed');
    expect(removed.backupPath).toBeDefined();
    const back = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof OWNER_CONFIG;
    expect(rightIds(back as never)).toEqual(['omarchy.tray', 'omarchy.audio', 'omarchy.power']);

    const stamp = fs.readFileSync(file, 'utf8');
    const { deps: d, reload } = deps(home);
    const again = uninstallRedlineBar(d);
    expect(again.status).toBe('not-installed');
    expect(fs.readFileSync(file, 'utf8')).toBe(stamp);
    expect(reload).not.toHaveBeenCalled();
  });
});
