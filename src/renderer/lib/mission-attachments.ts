// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só a normalização
// de MIME por extensão (composerAttachmentFiles.ts:23–63) veio do T3, com
// avif/heic/heif no mapa; classificação, limites, paste e staging são do Nexus.

export const MISSION_CONTEXT_ATTACHMENT_PREFIX =
  '.nexus/attachments/mission-context/';

export function isMissionContextAttachmentPath(value: string): boolean {
  return value.replaceAll('\\', '/').startsWith(MISSION_CONTEXT_ATTACHMENT_PREFIX);
}

export type MissionAttachmentKind = 'image' | 'audio' | 'file' | 'document';

export type MissionAttachment = {
  id: string;
  name: string;
  kind: MissionAttachmentKind;
  mime: string;
  size: number;
  path: string;
};

export const MISSION_ATTACHMENT_LIMITS = {
  maxCount: 6,
  maxBytesPerFile: 14 * 1024 * 1024,
  maxBytesTotal: 40 * 1024 * 1024,
} as const;

// heif: o Finder entrega `.heif` com MIME vazio — sem ele a foto sumia.
const IMAGE_EXTENSIONS = /\.(avif|gif|heic|heif|jpeg|jpg|png|webp)$/i;
// opus = áudio de WhatsApp/Telegram (o paste do Finder entrega MIME vazio);
// oga = ogg de áudio; aiff/wma = gravadores e Windows.
const AUDIO_EXTENSIONS = /\.(aac|aiff|flac|m4a|mp3|oga|ogg|opus|wav|webm|wma)$/i;
const TEXT_EXTENSIONS =
  /\.(c|cc|cpp|cs|css|csv|go|html?|java|js|json|jsx|md|mdx|php|py|rb|rs|sh|sql|svelte|toml|ts|tsx|txt|vue|ya?ml)$/i;
// PDF/Office arrastados do Finder chegam com MIME vazio — extensão decide.
// Voo real 19/08: contrato .pdf morria em silêncio no wizard E no pane.
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|rtf|epub)$/i;
const DOCUMENT_MIMES =
  /^application\/(pdf|msword|rtf|epub\+zip|vnd\.(openxmlformats-officedocument\.[\w.-]+|ms-(word|excel|powerpoint)|oasis\.opendocument\.[\w-]+))$/i;
let attachmentSequence = 0;

function fileName(file: Pick<File, 'name'>): string {
  return file.name.trim() || 'anexo';
}

export function classifyMissionAttachment(
  file: Pick<File, 'name' | 'type'>,
): MissionAttachmentKind | null {
  const mime = file.type.toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.test(fileName(file))) {
    return 'image';
  }
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.test(fileName(file))) {
    return 'audio';
  }
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.test(fileName(file))) {
    return 'file';
  }
  if (DOCUMENT_MIMES.test(mime) || DOCUMENT_EXTENSIONS.test(fileName(file))) {
    return 'document';
  }
  return null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty or generic MIME type. Maps the extension to a
 * concrete image type so a plain `photo.heif` still lands on the image path;
 * anything unrecognized stays as it was.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, 'name' | 'type'>): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== '' && mimeType !== 'application/octet-stream') {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

/** Give extension-recognized images a concrete type before preparation. */
export function normalizeMissionImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

/** Clipboard image names are often blank or generic (`image.png`). */
const GENERIC_PASTE_NAMES = new Set(['', 'image.png', 'image.jpg', 'image.jpeg', 'blob', 'untitled']);

function extensionForMime(mime: string, kind: MissionAttachmentKind): string {
  const normalized = mime.toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/heic') return 'heic';
  if (normalized === 'image/heif') return 'heif';
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a';
  if (normalized === 'audio/wav' || normalized === 'audio/wave') return 'wav';
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'audio/ogg' || normalized === 'audio/opus') {
    return 'opus';
  }
  if (normalized === 'audio/aiff' || normalized === 'audio/x-aiff') {
    return 'aiff';
  }
  if (normalized === 'video/mp4') return 'mp4';
  if (normalized === 'video/quicktime') return 'mov';
  if (normalized === 'video/webm') return 'webm';
  if (normalized === 'video/x-matroska') return 'mkv';
  if (normalized === 'application/pdf') return 'pdf';
  if (kind === 'image') return 'png';
  if (kind === 'audio') return 'm4a';
  if (kind === 'document') return 'pdf';
  // kind 'file' (anyKind do pane): MIME desconhecido → o subtype serve de
  // extensão quando é curto e alfanumérico; senão, bin neutro.
  if (kind === 'file') {
    const subtype = normalized.split('/')[1] ?? '';
    return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : 'bin';
  }
  return 'txt';
}

/**
 * Give pasted screenshots a stable, human name so the list doesn't show
 * anonymous "image.png" / "anexo" rows.
 */
export function namePastedMissionFile(file: File, kind: MissionAttachmentKind): File {
  const current = file.name.trim().toLowerCase();
  if (current && !GENERIC_PASTE_NAMES.has(current)) return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix =
    kind === 'image'
      ? 'print'
      : kind === 'audio'
        ? 'audio'
        : kind === 'document'
          ? 'documento'
          : 'anexo';
  const ext = extensionForMime(file.type, kind);
  return new File([file], `${prefix}-${stamp}.${ext}`, {
    type:
      file.type ||
      (kind === 'image'
        ? 'image/png'
        : kind === 'audio'
          ? 'audio/*'
          : kind === 'document'
            ? 'application/pdf'
            : 'application/octet-stream'),
    lastModified: file.lastModified,
  });
}

type ClipboardFileSource = {
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }>;
  files?: ArrayLike<File>;
};

/**
 * Identity of a pasted/dropped blob that survives rename (`image.png` →
 * `print-…png`) and a second paste event of the same clipboard bytes.
 */
export async function missionAttachmentContentKey(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const hex = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    return `${file.size}:${hex}`;
  }
  let hash = file.size >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = (Math.imul(hash, 33) + bytes[index]!) >>> 0;
  }
  return `${file.size}:${hash.toString(16)}`;
}

/**
 * Extract image/audio files from a paste event.
 * Screenshots (⌘⇧⌃4 → clipboard → ⌘V) land as image/* items with no path.
 * Returns [] when the paste is text-only so callers leave the textarea alone.
 *
 * Dedupes by name+size+type so items/files dual listing and multi-item paste
 * of the same blob don't double-attach.
 */
export function filesFromClipboardData(
  data: ClipboardFileSource | DataTransfer | null | undefined,
  options: { anyKind?: boolean } = {},
): File[] {
  if (!data) return [];
  const collected: File[] = [];
  const seen = new Set<string>();

  const pushIfAttachable = (file: File | null | undefined) => {
    if (!file) return;
    // anyKind (pane): o drop aceita qualquer arquivo — a cópia é inofensiva.
    const kind =
      classifyMissionAttachment(file) ?? (options.anyKind ? 'file' : null);
    if (!kind) return;
    // `lastModified` NÃO entra na chave: para um blob de clipboard o navegador
    // sintetiza um File a cada acessor, carimbando o instante da chamada. O
    // mesmo print vinha por `items` e por `files` com timestamps a um
    // milissegundo de distância e era anexado duas vezes (campo 09/09).
    const key = `${file.name}\0${file.size}\0${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(namePastedMissionFile(file, kind));
  };

  const items = data.items;
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || item.kind !== 'file') continue;
      pushIfAttachable(item.getAsFile());
    }
  }

  if (data.files) {
    for (let index = 0; index < data.files.length; index += 1) {
      pushIfAttachable(data.files[index]);
    }
  }

  return collected;
}

export function validateMissionAttachment(
  file: Pick<File, 'name' | 'type' | 'size'>,
  current: readonly MissionAttachment[],
): string | null {
  const kind = classifyMissionAttachment(file);
  if (!kind) {
    return 'Use uma imagem, um áudio, um documento (PDF/Office) ou um arquivo de código/texto.';
  }
  if (current.length >= MISSION_ATTACHMENT_LIMITS.maxCount) {
    return `Você pode anexar no máximo ${MISSION_ATTACHMENT_LIMITS.maxCount} arquivos.`;
  }
  if (file.size <= 0) return `${fileName(file)} está vazio.`;
  if (file.size > MISSION_ATTACHMENT_LIMITS.maxBytesPerFile) {
    return `${fileName(file)} excede o limite de 14 MB por arquivo.`;
  }
  const total = current.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total + file.size > MISSION_ATTACHMENT_LIMITS.maxBytesTotal) {
    return 'Os anexos excedem o limite total de 40 MB.';
  }
  return null;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function stageMissionAttachment(
  file: File,
  options: { allowAnyKind?: boolean } = {},
): Promise<MissionAttachment> {
  return (await stageMissionAttachmentWithLocation(file, options)).attachment;
}

/**
 * Como `stageMissionAttachment`, e devolve também onde o Main gravou o arquivo
 * (caminho absoluto). Fica FORA de `MissionAttachment`: aquele tipo viaja para
 * missões e não deve ganhar campo que o Main não espera.
 */
export async function stageMissionAttachmentWithLocation(
  file: File,
  options: { allowAnyKind?: boolean } = {},
): Promise<{ attachment: MissionAttachment; absolutePath?: string }> {
  // O pane aceita QUALQUER arquivo (allowAnyKind): a cópia de bytes para
  // .nexus/attachments/ é inofensiva e o agente decide o que fazer com ela.
  const kind =
    classifyMissionAttachment(file) ??
    (options.allowAnyKind ? 'file' : null);
  if (!kind) throw new Error('Formato de anexo não suportado.');
  const result = await window.nexus.files.importMissionAttachment(
    fileName(file),
    bufferToBase64(await file.arrayBuffer()),
  );
  if (!result.ok || !result.path) {
    throw new Error(result.error ?? `Não foi possível salvar ${fileName(file)}.`);
  }
  attachmentSequence += 1;
  const attachment: MissionAttachment = {
    id: `${Date.now().toString(36)}-${attachmentSequence}`,
    name: fileName(file),
    kind,
    mime:
      file.type ||
      (kind === 'image'
        ? 'image/*'
        : kind === 'audio'
          ? 'audio/*'
          : kind === 'document'
            ? 'application/pdf'
            : 'text/plain'),
    size: file.size,
    path: result.path,
  };
  return {
    attachment,
    ...(result.absolutePath ? { absolutePath: result.absolutePath } : {}),
  };
}

export function formatMissionAttachmentSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildMissionAttachmentsContext(
  attachments: readonly MissionAttachment[],
): string {
  if (attachments.length === 0) return '';
  const labelFor = (kind: MissionAttachmentKind): string =>
    kind === 'image'
      ? 'print'
      : kind === 'audio'
        ? 'áudio'
        : kind === 'document'
          ? 'documento'
          : 'arquivo';
  return [
    '## Evidências anexadas pelo usuário',
    'Consulte estes arquivos durante a missão. Eles podem conter prints de erro, gravações de áudio ou arquivos de código relevantes ao objetivo:',
    ...attachments.map((attachment) => `- ${labelFor(attachment.kind)}: ${attachment.path}`),
  ].join('\n');
}

/**
 * Global drop intake: files dropped anywhere on the app shell (outside the
 * attachment picker's own drop zone) are parked here, then the wizard opens
 * and the picker consumes them on mount. Bridges the window-level drop event
 * to the picker without prop-drilling through the wizard.
 */
let pendingDroppedFiles: File[] = [];

export function enqueueDroppedFiles(files: File[]): void {
  pendingDroppedFiles = pendingDroppedFiles.concat(files);
}

export function consumeDroppedFiles(): File[] {
  const files = pendingDroppedFiles;
  pendingDroppedFiles = [];
  return files;
}

/** Discard unconsumed drops (wizard closed before the picker mounted). */
export function clearDroppedFiles(): void {
  pendingDroppedFiles = [];
}
