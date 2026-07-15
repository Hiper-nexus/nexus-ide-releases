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
