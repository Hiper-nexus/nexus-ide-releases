import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractLinuxZip, readZipEntries, ZipRejected, ZIP_ROOT } from './linux-zip-extract';

interface FakeEntry {
  name: string;
  data?: Buffer;
  mode?: number; // permissões + tipo (S_IF*)
  deflate?: boolean;
  crc?: number; // sobrescreve o CRC
  declaredSize?: number; // sobrescreve o tamanho descompactado declarado
  declaredCompressed?: number;
}

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00, 0x3e, 0x00]), Buffer.alloc(40)]);
const REG = 0o100000;
const DIR = 0o040000;
const LNK = 0o120000;

function buildZip(entries: FakeEntry[], { zip64 = false, truncate = false }: { zip64?: boolean; truncate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data ?? Buffer.alloc(0);
    const stored = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = entry.crc ?? zlib.crc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const compressed = entry.declaredCompressed ?? stored.length;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? REG | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, centralBuffer, eocd]);
  return truncate ? all.subarray(0, all.length - 30) : all;
}

const good = (extra: FakeEntry[] = []): FakeEntry[] => [
  { name: `${ZIP_ROOT}/`, mode: DIR | 0o755 },
  { name: `${ZIP_ROOT}/nexus-ide`, data: ELF, mode: REG | 0o755, deflate: true },
  { name: `${ZIP_ROOT}/resources/`, mode: DIR | 0o755 },
  { name: `${ZIP_ROOT}/resources/app.asar`, data: Buffer.from('conteudo-do-asar'.repeat(100)), mode: REG | 0o644, deflate: true },
  { name: `${ZIP_ROOT}/LICENSE`, data: Buffer.from('licenca'), mode: REG | 0o644 },
  { name: `${ZIP_ROOT}/vazio.txt`, mode: REG | 0o644 },
  { name: `${ZIP_ROOT}/lib/`, mode: DIR | 0o755 },
  { name: `${ZIP_ROOT}/lib/libx.so.1`, data: Buffer.from('lib'), mode: REG | 0o755 },
  { name: `${ZIP_ROOT}/lib/libx.so`, data: Buffer.from('libx.so.1'), mode: LNK | 0o777 },
  ...extra,
];

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-zip-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function archive(entries: FakeEntry[], options?: Parameters<typeof buildZip>[1]): { zip: string; out: string } {
  const dir = tmp();
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, buildZip(entries, options));
  return { zip, out: path.join(dir, 'novo') };
}

describe('extractLinuxZip', () => {
  it('extrai sem a raiz, com modos, link relativo e o executável ELF', async () => {
    const { zip, out } = archive(good());
    const binary = await extractLinuxZip(zip, out);
    expect(binary).toBe(path.join(out, 'nexus-ide'));
    expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(out, 'resources', 'app.asar'), 'utf8')).toBe('conteudo-do-asar'.repeat(100));
    expect(fs.statSync(path.join(out, 'resources', 'app.asar')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(out, 'LICENSE'), 'utf8')).toBe('licenca');
    expect(fs.statSync(path.join(out, 'vazio.txt')).size).toBe(0);
    expect(fs.lstatSync(path.join(out, 'lib', 'libx.so')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(out, 'lib', 'libx.so'))).toBe('libx.so.1');
    expect(fs.readFileSync(path.join(out, 'lib', 'libx.so'), 'utf8')).toBe('lib');
  });

  it('recusa destino que já existe e não toca nele', async () => {
    const { zip, out } = archive(good());
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'meu.txt'), 'meu');
    await expect(extractLinuxZip(zip, out)).rejects.toBeInstanceOf(ZipRejected);
    expect(fs.readFileSync(path.join(out, 'meu.txt'), 'utf8')).toBe('meu');
  });

  const attacks: Array<[string, FakeEntry[], RegExp]> = [
    ['caminho com ..', good([{ name: `${ZIP_ROOT}/../evil`, data: Buffer.from('x') }]), /inválido|escapa/u],
    ['caminho absoluto', good([{ name: '/etc/evil', data: Buffer.from('x') }]), /inválido|escapa/u],
    ['barra invertida', good([{ name: `${ZIP_ROOT}\\evil`, data: Buffer.from('x') }]), /inválido|escapa/u],
    ['outra raiz', good([{ name: 'Outra/arquivo', data: Buffer.from('x') }]), /inválido|escapa/u],
    ['duplicata', good([{ name: `${ZIP_ROOT}/LICENSE`, data: Buffer.from('y') }]), /duplicado/u],
    ['byte de controle', good([{ name: `${ZIP_ROOT}/a\u0001b`, data: Buffer.from('x') }]), /inválido/u],
    ['arquivo especial (FIFO)', good([{ name: `${ZIP_ROOT}/fifo`, mode: 0o010000 | 0o644 }]), /especial/u],
    ['link para fora (..)', good([{ name: `${ZIP_ROOT}/lib/fuga`, data: Buffer.from('../../../etc/passwd'), mode: LNK | 0o777 }]), /link escapa/u],
    ['link absoluto', good([{ name: `${ZIP_ROOT}/lib/abs`, data: Buffer.from('/etc/passwd'), mode: LNK | 0o777 }]), /link escapa/u],
    ['entrada dentro de link', good([{ name: `${ZIP_ROOT}/lib/libx.so/dentro`, data: Buffer.from('x') }]), /link como pasta/u],
    ['sem o executável', good().filter((entry) => entry.name !== `${ZIP_ROOT}/nexus-ide`), /executável/u],
    ['executável é link', good().map((entry) => (entry.name === `${ZIP_ROOT}/nexus-ide` ? { name: entry.name, data: Buffer.from('resources/app.asar'), mode: LNK | 0o777 } : entry)), /executável/u],
    ['método desconhecido', good(), /^$/u],
  ];
  for (const [label, entries, pattern] of attacks.filter(([label]) => label !== 'método desconhecido')) {
    it(`recusa: ${label}`, async () => {
      const { zip, out } = archive(entries);
      await expect(extractLinuxZip(zip, out)).rejects.toThrow(pattern);
      expect(fs.existsSync(out)).toBe(false);
    });
  }

  it('recusa executável que não é ELF x86-64 e limpa o que extraiu', async () => {
    const { zip, out } = archive(good().map((entry) => (entry.name === `${ZIP_ROOT}/nexus-ide` ? { ...entry, data: Buffer.from('#!/bin/sh\necho oi\n'.padEnd(64, ' ')) } : entry)));
    await expect(extractLinuxZip(zip, out)).rejects.toThrow(/ELF/u);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('recusa ELF de outra arquitetura (aarch64)', async () => {
    const arm = Buffer.from(ELF);
    arm.writeUInt16LE(183, 18);
    const { zip, out } = archive(good().map((entry) => (entry.name === `${ZIP_ROOT}/nexus-ide` ? { ...entry, data: arm } : entry)));
    await expect(extractLinuxZip(zip, out)).rejects.toThrow(/ELF/u);
  });

  it('recusa CRC errado, tamanho declarado diferente e dados truncados', async () => {
    for (const bad of [
      { crc: 0xdeadbeef },
      { declaredSize: 5 },
      { declaredSize: 999_999 },
    ]) {
      const { zip, out } = archive(good().map((entry) => (entry.name === `${ZIP_ROOT}/resources/app.asar` ? { ...entry, ...bad } : entry)));
      await expect(extractLinuxZip(zip, out)).rejects.toThrow();
      expect(fs.existsSync(out)).toBe(false);
    }
    const truncated = archive(good(), { truncate: true });
    await expect(extractLinuxZip(truncated.zip, truncated.out)).rejects.toThrow();
  });

  it('recusa ZIP64, arquivo curto e lixo', async () => {
    const z64 = archive(good(), { zip64: true });
    await expect(extractLinuxZip(z64.zip, z64.out)).rejects.toThrow(/ZIP64/u);
    const dir = tmp();
    const tiny = path.join(dir, 't.zip');
    fs.writeFileSync(tiny, 'PK');
    await expect(extractLinuxZip(tiny, path.join(dir, 'o'))).rejects.toThrow(/pequeno/u);
    const junk = path.join(dir, 'j.zip');
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    await expect(extractLinuxZip(junk, path.join(dir, 'o2'))).rejects.toThrow(/fim do diretório/u);
  });

  it('recusa razão de compressão de ZIP-bomba', async () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024);
    const { zip, out } = archive(good([{ name: `${ZIP_ROOT}/bomba.bin`, data: bomb, deflate: true }]));
    await expect(extractLinuxZip(zip, out)).rejects.toThrow(/razão/u);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('readZipEntries lista só o que é válido', async () => {
    const { zip } = archive(good());
    const entries = await readZipEntries(zip);
    expect(entries.map((entry) => entry.kind).filter((kind) => kind === 'symlink')).toHaveLength(1);
    expect(entries.some((entry) => entry.name === `${ZIP_ROOT}/nexus-ide`)).toBe(true);
  });
});
