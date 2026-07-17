export type MissionAttachmentKind = 'image' | 'audio';

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

const IMAGE_EXTENSIONS = /\.(avif|gif|heic|jpeg|jpg|png|webp)$/i;
const AUDIO_EXTENSIONS = /\.(aac|flac|m4a|mp3|ogg|wav|webm)$/i;
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
  return null;
}

/** Clipboard image names are often blank or generic (`image.png`). */
const GENERIC_PASTE_NAMES = new Set(['', 'image.png', 'image.jpg', 'image.jpeg', 'blob', 'untitled']);

function extensionForMime(mime: string, kind: MissionAttachmentKind): string {
  const normalized = mime.toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a';
  if (normalized === 'audio/wav' || normalized === 'audio/wave') return 'wav';
  if (normalized === 'audio/webm') return 'webm';
  return kind === 'image' ? 'png' : 'm4a';
}

/**
 * Give pasted screenshots a stable, human name so the list doesn't show
 * anonymous "image.png" / "anexo" rows.
 */
export function namePastedMissionFile(file: File, kind: MissionAttachmentKind): File {
  const current = file.name.trim().toLowerCase();
  if (current && !GENERIC_PASTE_NAMES.has(current)) return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = kind === 'image' ? 'print' : 'audio';
  const ext = extensionForMime(file.type, kind);
  return new File([file], `${prefix}-${stamp}.${ext}`, {
    type: file.type || (kind === 'image' ? 'image/png' : 'audio/*'),
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
 * Extract image/audio files from a paste event.
 * Screenshots (⌘⇧⌃4 → clipboard → ⌘V) land as image/* items with no path.
 * Returns [] when the paste is text-only so callers leave the textarea alone.
 *
 * Dedupes by name+size+type+lastModified so items/files dual listing and
 * multi-item paste of the same blob don't double-attach.
 */
export function filesFromClipboardData(
  data: ClipboardFileSource | DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const collected: File[] = [];
  const seen = new Set<string>();

  const pushIfAttachable = (file: File | null | undefined) => {
    if (!file) return;
    const kind = classifyMissionAttachment(file);
    if (!kind) return;
    const key = `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
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

  if (collected.length === 0 && data.files) {
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
  if (!kind) return 'Use uma imagem (print) ou um arquivo de áudio.';
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
): Promise<MissionAttachment> {
  const kind = classifyMissionAttachment(file);
  if (!kind) throw new Error('Formato de anexo não suportado.');
  const result = await window.nexus.files.saveDropped(
    fileName(file),
    bufferToBase64(await file.arrayBuffer()),
  );
  if (!result.ok || !result.path) {
    throw new Error(result.error ?? `Não foi possível salvar ${fileName(file)}.`);
  }
  attachmentSequence += 1;
  return {
    id: `${Date.now().toString(36)}-${attachmentSequence}`,
    name: fileName(file),
    kind,
    mime: file.type || (kind === 'image' ? 'image/*' : 'audio/*'),
    size: file.size,
    path: result.path,
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
  return [
    '## Evidências anexadas pelo usuário',
    'Consulte estes arquivos durante a missão. Eles podem conter prints de erro ou gravações de áudio relevantes ao objetivo:',
    ...attachments.map(
      (attachment) =>
        `- ${attachment.kind === 'image' ? 'print' : 'áudio'}: ${attachment.path}`,
    ),
  ].join('\n');
}
