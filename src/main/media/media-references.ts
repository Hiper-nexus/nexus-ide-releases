import fs from 'node:fs';
import path from 'node:path';
import {
  MEDIA_REFERENCE_DIR,
  MEDIA_REFERENCE_MAX_BYTES,
  type MediaReferenceInfo,
  type MediaReferenceKind,
  type MediaReferenceSaveResult,
} from '../../shared/media-reference-types';
import {
  readMediaInput,
  resolveMediaOutputPath,
  writeMediaOutput,
} from './media-path-policy';

/**
 * Biblioteca de referências do projeto (F-1611). Puro sobre o sistema de
 * arquivos — sem Electron: a Lixeira entra injetada.
 *
 * O tipo vem dos primeiros bytes, não da extensão: um `.png` que é um
 * executável renomeado não entra, e o arquivo gravado leva a extensão do que
 * ele é de verdade.
 */

interface DetectedFormat {
  kind: MediaReferenceKind;
  ext: string;
  mime: string;
  vector: boolean;
}

const FORMAT_BY_EXT: Readonly<Record<string, DetectedFormat>> = {
  png: { kind: 'image', ext: 'png', mime: 'image/png', vector: false },
  jpg: { kind: 'image', ext: 'jpg', mime: 'image/jpeg', vector: false },
  webp: { kind: 'image', ext: 'webp', mime: 'image/webp', vector: false },
  gif: { kind: 'image', ext: 'gif', mime: 'image/gif', vector: false },
  svg: { kind: 'image', ext: 'svg', mime: 'image/svg+xml', vector: true },
  mp4: { kind: 'video', ext: 'mp4', mime: 'video/mp4', vector: false },
  mov: { kind: 'video', ext: 'mov', mime: 'video/quicktime', vector: false },
  webm: { kind: 'video', ext: 'webm', mime: 'video/webm', vector: false },
};

const ACCEPTED_LABEL = 'PNG, JPG, WEBP, GIF, SVG, MP4, MOV ou WEBM';

/** Prévia em base64 atravessa o IPC: mesmo teto da galeria do Estúdio. */
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end));
}

/** Formato pelos bytes iniciais; `null` quando não é um dos aceitos. */
export function detectReferenceFormat(data: Uint8Array): DetectedFormat | null {
  if (data.length >= 8 && ascii(data, 1, 4) === 'PNG' && data[0] === 0x89) {
    return FORMAT_BY_EXT.png;
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return FORMAT_BY_EXT.jpg;
  }
  if (data.length >= 6 && ascii(data, 0, 4) === 'GIF8') return FORMAT_BY_EXT.gif;
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') {
    return FORMAT_BY_EXT.webp;
  }
  if (data.length >= 12 && ascii(data, 4, 8) === 'ftyp') {
    // QuickTime declara a marca `qt  `; o resto da família ISO-BMFF é MP4.
    return ascii(data, 8, 12) === 'qt  ' ? FORMAT_BY_EXT.mov : FORMAT_BY_EXT.mp4;
  }
  if (
    data.length >= 4 &&
    data[0] === 0x1a &&
    data[1] === 0x45 &&
    data[2] === 0xdf &&
    data[3] === 0xa3
  ) {
    return FORMAT_BY_EXT.webm;
  }
  const head = Buffer.from(data.subarray(0, 2048))
    .toString('utf8')
    .replace(/^\uFEFF/u, '')
    .trimStart();
  if (head.startsWith('<') && /<svg[\s>]/iu.test(head)) return FORMAT_BY_EXT.svg;
  return null;
}

/** `Logo Café (final).PNG` → `logo-cafe-final`. */
export function referenceBaseName(original: string): string {
  const base = path.basename(original.replace(/\\/gu, '/')).replace(/\.[^.]*$/u, '');
  const slug = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '');
  return slug || 'referencia';
}

function isReferenceKey(storageKey: string): boolean {
  const prefix = `${MEDIA_REFERENCE_DIR}/`;
  if (!storageKey.startsWith(prefix)) return false;
  const file = storageKey.slice(prefix.length);
  return (
    file.length > 0 &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.startsWith('.') &&
    file !== '..'
  );
}

function formatOfFile(file: string): DetectedFormat | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  return FORMAT_BY_EXT[ext] ?? null;
}

/** `lzx3k1a0-logo-cafe.png` → `logo-cafe.png` (o prefixo só garante unicidade). */
function displayName(file: string): string {
  return file.replace(/^[0-9a-z]{6,12}-/u, '');
}

function info(file: string, stat: fs.Stats, format: DetectedFormat): MediaReferenceInfo {
  return {
    storageKey: `${MEDIA_REFERENCE_DIR}/${file}`,
    name: displayName(file),
    kind: format.kind,
    bytes: stat.size,
    vector: format.vector,
    addedAt: Math.round(stat.mtimeMs),
  };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function saveReference(
  baseDir: string,
  originalName: string,
  data: Buffer,
  now: () => number = Date.now,
): MediaReferenceSaveResult {
  if (data.length === 0) return { ok: false, error: 'O arquivo está vazio.' };
  const format = detectReferenceFormat(data);
  if (!format) {
    return {
      ok: false,
      error: `Formato não aceito em "${path.basename(originalName)}". Use ${ACCEPTED_LABEL}.`,
    };
  }
  const max = MEDIA_REFERENCE_MAX_BYTES[format.kind];
  if (data.length > max) {
    return {
      ok: false,
      error:
        format.kind === 'video'
          ? `Vídeo de exemplo com mais de ${formatMb(max)}. Corte um trecho curto e tente de novo.`
          : `Imagem com mais de ${formatMb(max)}. Reduza o tamanho e tente de novo.`,
    };
  }
  const base = referenceBaseName(originalName);
  const stamp = now().toString(36);
  let file = `${stamp}-${base}.${format.ext}`;
  for (let n = 2; fs.existsSync(path.join(baseDir, MEDIA_REFERENCE_DIR, file)); n += 1) {
    file = `${stamp}-${base}-${n}.${format.ext}`;
  }
  const storageKey = `${MEDIA_REFERENCE_DIR}/${file}`;
  writeMediaOutput(storageKey, baseDir, data);
  const stat = fs.statSync(resolveMediaOutputPath(storageKey, baseDir));
  return { ok: true, reference: info(file, stat, format) };
}

/** Mais nova primeiro. Pasta ausente = nenhuma referência ainda. */
export function listReferences(baseDir: string): MediaReferenceInfo[] {
  const dir = path.join(baseDir, MEDIA_REFERENCE_DIR);
  let entries: fs.Dirent[];
  try {
    // Um symlink (na pasta ou no `media/`) para fora do projeto não vira
    // biblioteca: a pasta real precisa morar dentro da raiz real.
    const realRoot = fs.realpathSync(baseDir);
    const realDir = fs.realpathSync(dir);
    if (!realDir.startsWith(`${realRoot}${path.sep}`)) return [];
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: MediaReferenceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const format = formatOfFile(entry.name);
    if (!format) continue;
    try {
      out.push(info(entry.name, fs.lstatSync(path.join(dir, entry.name)), format));
    } catch {
      // Sumiu entre o readdir e o stat: fica fora da lista.
    }
  }
  return out.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
}

export async function removeReference(
  baseDir: string,
  storageKey: string,
  trash: (absolutePath: string) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  if (!isReferenceKey(storageKey)) {
    return { ok: false, error: 'Só arquivos da pasta de referências podem ser removidos aqui.' };
  }
  const abs = resolveMediaOutputPath(storageKey, baseDir);
  if (!fs.existsSync(abs)) return { ok: true };
  await trash(abs);
  return { ok: true };
}

export function readReferenceDataUrl(
  baseDir: string,
  storageKey: string,
): { ok: boolean; dataUrl?: string; error?: string } {
  if (!isReferenceKey(storageKey)) {
    return { ok: false, error: 'Referência fora da pasta de referências.' };
  }
  const format = formatOfFile(storageKey);
  if (!format) return { ok: false, error: 'Tipo sem prévia.' };
  try {
    const abs = resolveMediaOutputPath(storageKey, baseDir);
    if (fs.statSync(abs).size > MAX_PREVIEW_BYTES) {
      return { ok: false, error: 'Arquivo grande demais para prévia.' };
    }
    const input = readMediaInput(storageKey, baseDir);
    return { ok: true, dataUrl: `data:${format.mime};base64,${input.data.toString('base64')}` };
  } catch {
    return { ok: false, error: 'Referência não encontrada no projeto.' };
  }
}
