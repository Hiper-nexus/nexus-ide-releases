/**
 * Extração segura do ZIP portátil do Linux, só com Node (sem `unzip`, sem Python).
 *
 * É o mesmo contrato de `scripts/extract-linux-zip.py`, que valida o ZIP no build: tudo sob uma única
 * raiz `NexusIDE-linux-x64/`, nada de caminho absoluto, `..`, duplicata, arquivo especial nem link
 * que escape da raiz ou passe por dentro de outro link; o executável tem de ser um ELF x86-64.
 * Acrescenta tetos contra ZIP-bomba, porque aqui o arquivo vem da rede.
 *
 * Só ZIP comum (sem ZIP64, sem criptografia): o build do app nunca gera outra coisa.
 */
import fs from './util/real-fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';

export const ZIP_ROOT = 'NexusIDE-linux-x64';
export const ZIP_LIMITS = Object.freeze({
  entries: 20_000,
  totalBytes: 3 * 1024 ** 3,
  entryBytes: 1024 ** 3,
  symlinkBytes: 4096,
  /** Razão máxima descompactado/compactado por entrada (as bibliotecas do Electron ficam abaixo de 20). */
  ratio: 200,
});

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
  readonly mode: number;
  readonly kind: 'file' | 'dir' | 'symlink';
}

export class ZipRejected extends Error {
  constructor(message: string) {
    super(`ZIP recusado: ${message}`);
    this.name = 'ZipRejected';
  }
}

const reject = (message: string): never => {
  throw new ZipRejected(message);
};

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) reject('arquivo truncado');
  return buffer;
}

/** Lê o diretório central e valida cada entrada. Não escreve nada. */
export async function readZipEntries(archivePath: string): Promise<ZipEntry[]> {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    if (fileSize < 22) reject('arquivo pequeno demais');
    const tailLength = Math.min(fileSize, 22 + 0xffff);
    const tail = await readAt(handle, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) reject('sem registro de fim do diretório central');
    const count = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) reject('ZIP64 não é aceito');
    if (count === 0 || count > ZIP_LIMITS.entries) reject('número de entradas fora do limite');
    if (centralOffset + centralSize > fileSize) reject('diretório central fora do arquivo');
    const central = await readAt(handle, centralOffset, centralSize);

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let position = 0;
    let totalBytes = 0;
    for (let index = 0; index < count; index += 1) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) reject('diretório central corrompido');
      const madeBy = central.readUInt16LE(position + 4);
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const crc32 = central.readUInt32LE(position + 16);
      const compressedSize = central.readUInt32LE(position + 20);
      const size = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const externalAttributes = central.readUInt32LE(position + 38);
      const localHeaderOffset = central.readUInt32LE(position + 42);
      const rawName = central.subarray(position + 46, position + 46 + nameLength);
      position += 46 + nameLength + extraLength + commentLength;
      if (position > central.length) reject('diretório central corrompido');
      if ((flags & 0x1) !== 0) reject('ZIP criptografado');
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) reject('ZIP64 não é aceito');
      const rawText = rawName.toString('utf8');
      const isDirName = rawText.endsWith('/');
      const name = isDirName ? rawText.slice(0, -1) : rawText;
      const parts = name.split('/');
      if (
        !name ||
        name.includes('\\') ||
        name.includes('\0') ||
        [...name].some((char) => char.charCodeAt(0) < 32) ||
        name.startsWith('/') ||
        parts.some((part) => part === '' || part === '.' || part === '..') ||
        parts[0] !== ZIP_ROOT ||
        seen.has(name)
      ) {
        reject('caminho inválido, duplicado ou que escapa da raiz');
      }
      seen.add(name);
      const unixHost = (madeBy >> 8) === 3;
      const mode = unixHost ? (externalAttributes >>> 16) & 0xffff : 0;
      const type = mode & S_IFMT;
      let kind: ZipEntry['kind'];
      if (type === S_IFLNK) kind = 'symlink';
      else if (type === S_IFDIR || isDirName) kind = 'dir';
      else if (type === 0 || type === S_IFREG) kind = 'file';
      else return reject('entrada especial do sistema de arquivos');
      if (method !== 0 && method !== 8) reject(`método de compressão ${method} não suportado`);
      if (kind === 'symlink' && size > ZIP_LIMITS.symlinkBytes) reject('alvo de link grande demais');
      if (size > ZIP_LIMITS.entryBytes) reject('entrada grande demais');
      if (compressedSize > 0 && size / compressedSize > ZIP_LIMITS.ratio && size > 1024 * 1024) reject('razão de compressão suspeita');
      totalBytes += size;
      if (totalBytes > ZIP_LIMITS.totalBytes) reject('tamanho total descompactado acima do limite');
      entries.push({ name, method, compressedSize, size, crc32, localHeaderOffset, mode, kind });
    }

    // Link nunca é pai de outra entrada: nada é escrito através de um link.
    const links = new Set(entries.filter((entry) => entry.kind === 'symlink').map((entry) => entry.name));
    for (const entry of entries) {
      const parts = entry.name.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (links.has(parts.slice(0, depth).join('/'))) reject('entrada com link como pasta pai');
      }
    }
    const binary = entries.find((entry) => entry.name === `${ZIP_ROOT}/nexus-ide`);
    if (!binary || binary.kind !== 'file') reject('o ZIP não traz o executável nexus-ide como arquivo comum');
    return entries;
  } finally {
    await handle.close();
  }
}

/** Contador de bytes e CRC32 em linha; recusa mais bytes do que o declarado. */
function checker(entry: ZipEntry): Transform {
  let received = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > entry.size) {
        callback(new ZipRejected('entrada maior do que o declarado'));
        return;
      }
      crc = zlib.crc32(chunk, crc);
      callback(null, chunk);
    },
    flush(callback) {
      if (received !== entry.size) callback(new ZipRejected('entrada menor do que o declarado'));
      else if (crc >>> 0 !== entry.crc32) callback(new ZipRejected('CRC32 não confere'));
      else callback();
    },
  });
}

async function dataStart(handle: FileHandle, entry: ZipEntry): Promise<number> {
  const header = await readAt(handle, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) reject('cabeçalho local corrompido');
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

async function readEntryBytes(archivePath: string, entry: ZipEntry): Promise<Buffer> {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const start = await dataStart(handle, entry);
    const raw = await readAt(handle, start, entry.compressedSize);
    const data = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.symlinkBytes }) : raw;
    if (data.length !== entry.size) reject('alvo do link com tamanho inesperado');
    return data;
  } finally {
    await handle.close();
  }
}

/**
 * Extrai para `destination` (que NÃO pode existir), já sem a pasta-raiz: `destination/nexus-ide` é o
 * executável. Apaga o que escreveu se qualquer coisa falhar. Devolve o caminho do executável.
 */
export async function extractLinuxZip(archivePath: string, destination: string): Promise<string> {
  const entries = await readZipEntries(archivePath);
  if (fs.existsSync(destination)) throw new ZipRejected('o destino já existe');
  const strip = (name: string): string => (name === ZIP_ROOT ? '' : name.slice(ZIP_ROOT.length + 1));
  const root = path.resolve(destination);
  const target = (name: string): string => {
    const resolved = path.resolve(root, strip(name));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) reject('caminho escapa do destino');
    return resolved;
  };
  await fs.promises.mkdir(root, { recursive: true, mode: 0o755 });
  try {
    const handle = await fs.promises.open(archivePath, 'r');
    try {
      for (const entry of entries) {
        const out = target(entry.name);
        if (entry.kind === 'dir') {
          await fs.promises.mkdir(out, { recursive: true, mode: 0o755 });
          continue;
        }
        await fs.promises.mkdir(path.dirname(out), { recursive: true, mode: 0o755 });
        if (entry.kind === 'symlink') {
          const linkTarget = (await readEntryBytes(archivePath, entry)).toString('utf8');
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), linkTarget));
          if (
            !linkTarget ||
            linkTarget.includes('\\') ||
            linkTarget.includes('\0') ||
            linkTarget.startsWith('/') ||
            !(resolved === ZIP_ROOT || resolved.startsWith(`${ZIP_ROOT}/`))
          ) {
            reject('link escapa da raiz da aplicação');
          }
          await fs.promises.symlink(linkTarget, out);
          continue;
        }
        const start = await dataStart(handle, entry);
        const source = fs.createReadStream(archivePath, {
          start,
          end: Math.max(start, start + entry.compressedSize - 1),
          highWaterMark: 256 * 1024,
        });
        const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [source];
        if (entry.compressedSize === 0 && entry.size === 0) {
          await fs.promises.writeFile(out, '', { mode: 0o644 });
        } else {
          if (entry.method === 8) stages.push(zlib.createInflateRaw());
          stages.push(checker(entry));
          stages.push(fs.createWriteStream(out, { mode: 0o644 }));
          await pipeline(stages as never);
        }
        const permissions = entry.mode & 0o777;
        await fs.promises.chmod(out, (permissions & 0o111) !== 0 ? 0o755 : 0o644);
      }
    } finally {
      await handle.close();
    }
    const binary = path.join(root, 'nexus-ide');
    const info = await fs.promises.lstat(binary);
    if (!info.isFile() || (info.mode & 0o111) === 0) reject('o executável extraído não é executável');
    const handleBinary = await fs.promises.open(binary, 'r');
    try {
      const header = await readAt(handleBinary, 0, 20);
      // ELF de 64 bits, little-endian, x86-64.
      if (header.subarray(0, 6).compare(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])) !== 0 || header.readUInt16LE(18) !== 62) {
        reject('o executável extraído não é um ELF x86-64');
      }
    } finally {
      await handleBinary.close();
    }
    return binary;
  } catch (error) {
    // Só links de dentro da raiz, que este extrator mesmo criou: o rm recursivo não segue symlink no Linux.
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  }
}
