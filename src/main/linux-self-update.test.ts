import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { keyIdOf, type UpdateSigningKey } from './linux-update-signing';
import {
  APPLY_SCRIPT,
  LINUX_SIG_NAME,
  LINUX_SUMS_NAME,
  detectLinuxInstall,
  launchApplyHelper,
  linuxUpdateUrls,
  scheduleOldInstallCleanup,
  stageLinuxUpdate,
  UpdateRefused,
  type LinuxInstall,
} from './linux-self-update';

const ROOT = 'NexusIDE-linux-x64';
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00, 0x3e, 0x00]), Buffer.alloc(40)]);

function zipOf(files: Array<{ name: string; data?: Buffer; mode: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const raw = file.data ?? Buffer.alloc(0);
    const stored = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((file.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

const VERSION = '0.76.198';
const ZIP_NAME = `NexusIDE-linux-x64-${VERSION}.zip`;
const REPOS = ['Hiper-nexus/nexus-ide-releases', 'Hiper-nexus/nexus-ide'];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function world(options: { sigFor?: (sums: string) => string; zipBytes?: Buffer; version?: string } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-self-'));
  dirs.push(base);
  const installDir = path.join(base, 'nexus-ide');
  fs.mkdirSync(path.join(installDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'resources', 'app.asar'), 'asar');
  fs.writeFileSync(path.join(installDir, 'nexus-ide'), 'velho', { mode: 0o755 });
  const install = { kind: 'portable', installDir, parentDir: base } as Extract<LinuxInstall, { kind: 'portable' }>;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key: UpdateSigningKey = { id: keyIdOf(pem), publicKeyPem: pem };
  const zip = options.zipBytes ?? zipOf([
    { name: `${ROOT}/`, mode: 0o040755 },
    { name: `${ROOT}/nexus-ide`, data: ELF, mode: 0o100755 },
    { name: `${ROOT}/resources/`, mode: 0o040755 },
    { name: `${ROOT}/resources/app.asar`, data: Buffer.from('novo-asar'), mode: 0o100644 },
  ]);
  const sums = `${createHash('sha256').update(zip).digest('hex')}  ${ZIP_NAME}\n`;
  const signature = options.sigFor ? options.sigFor(sums) : sign(null, Buffer.from(sums), privateKey).toString('base64');
  const served = new Map<string, string | Buffer>();
  const url = (repo: string, name: string) => `https://github.com/${repo}/releases/download/v${VERSION}/${name}`;
  served.set(url(REPOS[0], LINUX_SUMS_NAME), sums);
  served.set(url(REPOS[0], LINUX_SIG_NAME), `${signature}\n`);
  served.set(url(REPOS[0], ZIP_NAME), zip);
  const requested: string[] = [];
  const deps = {
    keys: [key],
    fetchText: vi.fn(async (u: string, max: number) => {
      requested.push(u);
      const body = served.get(u);
      if (body === undefined) throw new Error(`HTTP 404 ${u}`);
      const text = body.toString();
      if (text.length > max) throw new Error('grande demais');
      return text;
    }),
    download: vi.fn(async (u: string, dest: string) => {
      requested.push(u);
      const body = served.get(u);
      if (body === undefined) throw new Error(`HTTP 404 ${u}`);
      fs.writeFileSync(dest, body);
    }),
  };
  return { base, install, deps, requested, sums, served };
}

const release = { version: VERSION, tag: `v${VERSION}` };

describe('detectLinuxInstall', () => {
  const base = { exists: () => true, canWrite: () => true, realpath: (p: string) => p };

  it('reconhece o pacote portátil do install.sh', () => {
    expect(detectLinuxInstall('/home/ana/.local/share/nexus-ide/nexus-ide', base)).toEqual({
      kind: 'portable',
      installDir: '/home/ana/.local/share/nexus-ide',
      parentDir: '/home/ana/.local/share',
    });
  });

  it('DEB, RPM e /opt são do gerenciador de pacotes', () => {
    for (const exe of ['/usr/lib/nexus-ide/nexus-ide', '/usr/lib64/nexus-ide/nexus-ide', '/opt/nexus-ide/nexus-ide', '/nix/store/abc-nexus/nexus-ide']) {
      expect(detectLinuxInstall(exe, base).kind, exe).toBe('system');
    }
  });

  it('sem escrita, sem app.asar, nome estranho ou erro: não se troca sozinho', () => {
    const home = '/home/ana/.local/share/nexus-ide/nexus-ide';
    expect(detectLinuxInstall(home, { ...base, canWrite: () => false }).kind).toBe('system');
    expect(detectLinuxInstall(home, { ...base, exists: () => false }).kind).toBe('system');
    expect(detectLinuxInstall('/home/ana/bin/outro', base).kind).toBe('system');
    expect(detectLinuxInstall(home, { ...base, realpath: () => { throw new Error('x'); } }).kind).toBe('system');
  });

  it('segue o link do executável até a pasta real', () => {
    const result = detectLinuxInstall('/home/ana/.local/bin/nexus-ide', { ...base, realpath: () => '/home/ana/Apps/nexus-ide/nexus-ide' });
    expect(result).toMatchObject({ kind: 'portable', installDir: '/home/ana/Apps/nexus-ide' });
  });
});

describe('linuxUpdateUrls', () => {
  it('monta as URLs só a partir de etiqueta válida e repositório conhecido', () => {
    const plan = linuxUpdateUrls(REPOS, release);
    expect(plan?.zipName).toBe(ZIP_NAME);
    expect(plan?.candidates[0]).toEqual({
      zip: `https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v${VERSION}/${ZIP_NAME}`,
      sums: `https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v${VERSION}/${LINUX_SUMS_NAME}`,
      sig: `https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v${VERSION}/${LINUX_SIG_NAME}`,
    });
    for (const bad of [
      { version: VERSION, tag: 'v0.76.999' },
      { version: '0.76', tag: 'v0.76' },
      { version: '../x', tag: 'v../x' },
      { version: VERSION, tag: `v${VERSION}/../../evil` },
    ]) {
      expect(linuxUpdateUrls(REPOS, bad), JSON.stringify(bad)).toBeNull();
    }
    expect(linuxUpdateUrls(['evil.com/x?y', 'sem barra'], release)).toBeNull();
  });
});

describe('stageLinuxUpdate', () => {
  it('baixa, confere assinatura e SHA-256, extrai ao lado e não mexe na instalação atual', async () => {
    const w = world();
    const staged = await stageLinuxUpdate({ install: w.install, currentVersion: '0.76.197', release, repos: REPOS, deps: w.deps });
    expect(staged.version).toBe(VERSION);
    expect(staged.stagedDir).toBe(`${w.install.installDir}.new`);
    expect(fs.readFileSync(path.join(staged.stagedDir, 'resources', 'app.asar'), 'utf8')).toBe('novo-asar');
    expect(fs.readFileSync(path.join(w.install.installDir, 'nexus-ide'), 'utf8')).toBe('velho');
    expect(fs.readdirSync(w.base).sort()).toEqual(['nexus-ide', 'nexus-ide.new']); // sem o ZIP temporário
  });

  it('recusa assinatura inválida, ZIP adulterado e somas de outra chave, sem deixar rastro', async () => {
    for (const setup of [
      world({ sigFor: () => Buffer.alloc(64, 1).toString('base64') }),
      world({ sigFor: (sums) => sign(null, Buffer.from(sums), generateKeyPairSync('ed25519').privateKey).toString('base64') }),
    ]) {
      await expect(stageLinuxUpdate({ install: setup.install, currentVersion: '0.76.197', release, repos: REPOS, deps: setup.deps })).rejects.toBeInstanceOf(UpdateRefused);
      expect(setup.deps.download).not.toHaveBeenCalled(); // nem baixa o ZIP sem somas confiáveis
      expect(fs.readdirSync(setup.base)).toEqual(['nexus-ide']);
    }
    const tampered = world();
    tampered.served.set(`https://github.com/${REPOS[0]}/releases/download/v${VERSION}/${ZIP_NAME}`, Buffer.concat([Buffer.alloc(0), Buffer.from('adulterado')]));
    await expect(stageLinuxUpdate({ install: tampered.install, currentVersion: '0.76.197', release, repos: REPOS, deps: tampered.deps })).rejects.toThrow(/SHA-256/u);
    expect(fs.readdirSync(tampered.base)).toEqual(['nexus-ide']);
  });

  it('versão igual ou menor é recusada antes de qualquer rede (sem downgrade)', async () => {
    const w = world();
    for (const current of ['0.76.198', '0.76.199', '1.0.0']) {
      await expect(stageLinuxUpdate({ install: w.install, currentVersion: current, release, repos: REPOS, deps: w.deps })).rejects.toThrow(/mais nova/u);
    }
    expect(w.deps.fetchText).not.toHaveBeenCalled();
  });

  it('versão sem .sig publicado não se atualiza sozinha', async () => {
    const w = world();
    w.served.delete(`https://github.com/${REPOS[0]}/releases/download/v${VERSION}/${LINUX_SIG_NAME}`);
    await expect(stageLinuxUpdate({ install: w.install, currentVersion: '0.76.197', release, repos: [REPOS[0]], deps: w.deps })).rejects.toThrow();
    expect(fs.readdirSync(w.base)).toEqual(['nexus-ide']);
  });

  it('cai para o segundo repositório quando o primeiro não responde', async () => {
    const w = world();
    const first = `https://github.com/${REPOS[0]}/releases/download/v${VERSION}/`;
    const second = `https://github.com/${REPOS[1]}/releases/download/v${VERSION}/`;
    for (const name of [LINUX_SUMS_NAME, LINUX_SIG_NAME, ZIP_NAME]) {
      w.served.set(second + name, w.served.get(first + name)!);
      w.served.delete(first + name);
    }
    const staged = await stageLinuxUpdate({ install: w.install, currentVersion: '0.76.197', release, repos: REPOS, deps: w.deps });
    expect(staged.version).toBe(VERSION);
    expect(w.requested.some((u) => u.includes(REPOS[1]))).toBe(true);
  });

  it('recusa ZIP que traz executável não-ELF e limpa tudo', async () => {
    const zip = zipOf([
      { name: `${ROOT}/nexus-ide`, data: Buffer.from('#!/bin/sh\necho x\n'.padEnd(64)), mode: 0o100755 },
    ]);
    const w = world({ zipBytes: zip });
    await expect(stageLinuxUpdate({ install: w.install, currentVersion: '0.76.197', release, repos: REPOS, deps: w.deps })).rejects.toThrow(/ELF/u);
    expect(fs.readdirSync(w.base)).toEqual(['nexus-ide']);
  });

  it('repassa o progresso do download', async () => {
    const w = world();
    const onProgress = vi.fn();
    w.deps.download.mockImplementation(async (u: string, dest: string) => {
      fs.writeFileSync(dest, w.served.get(u)!);
      onProgress(10, 100);
    });
    await stageLinuxUpdate({ install: w.install, currentVersion: '0.76.197', release, repos: REPOS, deps: { ...w.deps, onProgress } });
    expect(onProgress).toHaveBeenCalledWith(10, 100);
  });
});

describe('launchApplyHelper', () => {
  const install = { kind: 'portable', installDir: '/home/ana/.local/share/nexus-ide', parentDir: '/home/ana/.local/share' } as Extract<LinuxInstall, { kind: 'portable' }>;

  it('grava o script constante e o dispara com PID, pasta nova e destino', () => {
    const writeScript = vi.fn();
    const spawnDetached = vi.fn();
    launchApplyHelper({ scriptPath: '/home/ana/.config/NexusIDE/apply.sh', pid: 4242, install, deps: { writeScript, spawnDetached } });
    expect(writeScript).toHaveBeenCalledWith('/home/ana/.config/NexusIDE/apply.sh', APPLY_SCRIPT);
    expect(spawnDetached).toHaveBeenCalledWith('/bin/sh', ['/home/ana/.config/NexusIDE/apply.sh', '4242', `${install.installDir}.new`, install.installDir]);
  });

  it('recusa PID inválido e caminho relativo', () => {
    const deps = { writeScript: vi.fn(), spawnDetached: vi.fn() };
    expect(() => launchApplyHelper({ scriptPath: '/x/a.sh', pid: 1, install, deps })).toThrow(UpdateRefused);
    expect(() => launchApplyHelper({ scriptPath: 'a.sh', pid: 99, install, deps })).toThrow(UpdateRefused);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it('o script recusa destino relativo, pasta nova que não é a irmã e executável ausente', () => {
    expect(APPLY_SCRIPT).toContain('[ "$new" = "$dest.new" ] || exit 64');
    expect(APPLY_SCRIPT).toContain('case "$dest" in /*) ;; *) exit 64 ;; esac');
    expect(APPLY_SCRIPT).toContain('[ -x "$new/nexus-ide" ] || exit 65');
    expect(APPLY_SCRIPT).toContain('mv "$old" "$dest"'); // volta atrás se a troca falhar
  });
});

describe('APPLY_SCRIPT de verdade (sh)', () => {
  it('troca a pasta depois que o PID some, guarda a antiga como .old e reabre o novo', async () => {
    const { spawnSync } = await import('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    dirs.push(base);
    const dest = path.join(base, 'nexus-ide');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'nexus-ide'), '#!/bin/sh\necho velho\n', { mode: 0o755 });
    fs.mkdirSync(`${dest}.new`);
    const marker = path.join(base, 'reaberto.txt');
    fs.writeFileSync(path.join(`${dest}.new`, 'nexus-ide'), `#!/bin/sh\necho "novo" > "${marker}"\n`, { mode: 0o755 });
    const script = path.join(base, 'apply.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o700 });
    const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const result = spawnSync('/bin/sh', [script, String(Number(dead.stdout.trim())), `${dest}.new`, dest], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    for (let i = 0; i < 50 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('novo');
    expect(fs.readFileSync(path.join(`${dest}.old`, 'nexus-ide'), 'utf8')).toContain('velho');
    expect(fs.existsSync(`${dest}.new`)).toBe(false);
  });

  it('recusa pasta nova que não é a irmã do destino e não mexe em nada', async () => {
    const { spawnSync } = await import('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    dirs.push(base);
    const dest = path.join(base, 'nexus-ide');
    fs.mkdirSync(dest);
    fs.mkdirSync(path.join(base, 'qualquer'));
    const script = path.join(base, 'apply.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o700 });
    const result = spawnSync('/bin/sh', [script, '999999', path.join(base, 'qualquer'), dest], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(fs.existsSync(dest)).toBe(true);
  });
});

describe('scheduleOldInstallCleanup', () => {
  it('só agenda quando existe a pasta .old e apaga depois do atraso', async () => {
    const w = world();
    expect(scheduleOldInstallCleanup(w.install, 5)).toBeNull();
    fs.mkdirSync(`${w.install.installDir}.old`);
    const remove = vi.fn(async () => undefined);
    expect(scheduleOldInstallCleanup(w.install, 5, remove)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(remove).toHaveBeenCalledWith(`${w.install.installDir}.old`);
  });
});
