/**
 * Regressão do bug que só aparece dentro do Electron (F-940): o `fs` normal trata `resources/app.asar` como arquivo
 * virtual e a extração da atualização falhava com "Invalid package". O vitest roda em Node puro e não vê isso; aqui o
 * extrator é empacotado e executado no runtime do Electron (ELECTRON_RUN_AS_NODE), que mantém o desvio de .asar.
 * Pula sozinho se o Electron ou o esbuild não estiverem instalados.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(__dirname, '..', '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
const available = process.platform === 'linux' && fs.existsSync(electron) && fs.existsSync(esbuild);

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00, 0x3e, 0x00]), Buffer.alloc(40)]);

function zipOf(files: Array<{ name: string; data: Buffer; mode: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const stored = zlib.deflateRawSync(file.data);
    const crc = zlib.crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(file.data.length, 24);
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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runInElectron(alias: string): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-electron-'));
  dirs.push(dir);
  const zip = path.join(dir, 'app.zip');
  fs.writeFileSync(zip, zipOf([
    { name: 'NexusIDE-linux-x64/nexus-ide', data: ELF, mode: 0o100755 },
    { name: 'NexusIDE-linux-x64/resources/app.asar', data: Buffer.from('conteudo-que-nao-e-um-asar'.repeat(40)), mode: 0o100644 },
  ]));
  const bundle = path.join(dir, 'bundle.cjs');
  const build = spawnSync(esbuild, [path.join(root, 'src/main/linux-zip-extract.ts'), '--bundle', '--platform=node', '--format=cjs', ...alias.split(' ').filter(Boolean), `--outfile=${bundle}`, '--log-level=error'], { encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
  const runner = path.join(dir, 'run.cjs');
  fs.writeFileSync(runner, `
    const { extractLinuxZip } = require(${JSON.stringify(bundle)});
    const real = require('original-fs');
    extractLinuxZip(${JSON.stringify(zip)}, ${JSON.stringify(path.join(dir, 'out'))}).then(
      () => console.log('RESULT ok ' + real.readFileSync(${JSON.stringify(path.join(dir, 'out', 'resources', 'app.asar'))}, 'utf8').slice(0, 10)),
      (error) => { console.log('RESULT falhou ' + String(error.message).slice(0, 60)); process.exitCode = 1; });
  `);
  const result = spawnSync(electron, [runner], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.split('\n').find((line) => line.startsWith('RESULT')) ?? result.stderr.slice(0, 200) };
}

describe.skipIf(!available)('extração do ZIP dentro do Electron (app.asar)', () => {
  it('o fs normal do Electron NÃO consegue gravar resources/app.asar (a razão do original-fs)', () => {
    const result = runInElectron('--alias:original-fs=node:fs');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('Invalid package');
  });

  it('com o original-fs a extração grava o app.asar e termina', () => {
    const result = runInElectron('--external:original-fs');
    expect(result.out).toBe('RESULT ok conteudo-q');
    expect(result.status).toBe(0);
  });
});
