import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MissionAttachmentSnapshot } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';

const MARKER = '.nexus/attachments/mission-context/';
const IMAGE_EXT = /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i;
const AUDIO_EXT = /\.(aac|aiff|flac|m4a|mp3|oga|ogg|opus|wav|webm|wma)$/i;
export const MISSION_TRANSCRIPT_SUFFIX = '.transcript.txt';
const MAX_TRANSCRIPT_CHARS = 4_000;

export type MissionAttachmentPromptKind = 'imagem' | 'áudio' | 'arquivo';

export function missionAttachmentPromptKind(name: string): MissionAttachmentPromptKind {
  if (IMAGE_EXT.test(name)) return 'imagem';
  if (AUDIO_EXT.test(name)) return 'áudio';
  return 'arquivo';
}

/** Caminho `.nexus/attachments/mission-context/<nome>` do snapshot, ou null. */
export function missionContextRelativePath(
  snapshot: Pick<MissionAttachmentSnapshot, 'sourcePath'>,
): string | null {
  const source = (snapshot.sourcePath ?? '').replaceAll('\\', '/');
  const indexed = source.indexOf(`/${MARKER}`);
  const relative =
    indexed >= 0 ? source.slice(indexed + 1) : source.startsWith(MARKER) ? source : '';
  return relative && !relative.includes('..') && !relative.startsWith('/') ? relative : null;
}

/** Transcrição já gravada ao lado do áudio (`<arquivo>.transcript.txt`), se houver. */
export function readMissionAttachmentTranscript(absoluteFile: string): string | null {
  try {
    const text = fs
      .readFileSync(absoluteFile + MISSION_TRANSCRIPT_SUFFIX, 'utf8')
      .trim();
    return text ? text.slice(0, MAX_TRANSCRIPT_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * O selo mora FORA do checkout e o `.nexus/attachments` nasce no checkout de
 * coordenação; a pasta isolada da aba (onde o Maestro roda) não tinha nenhum
 * dos dois. Copia os bytes selados (conferindo o sha256) e a transcrição
 * vizinha para o escopo de execução. Idempotente; devolve os caminhos que
 * ficaram legíveis ali.
 */
export function stageMissionAttachmentsIntoExecutionScope(
  executionScope: Pick<ProjectExecutionScope, 'rootRealPath'>,
  snapshots: readonly MissionAttachmentSnapshot[],
): string[] {
  const staged: string[] = [];
  for (const snapshot of snapshots) {
    const relative = missionContextRelativePath(snapshot);
    if (!relative) continue;
    const target = path.join(executionScope.rootRealPath, relative);
    try {
      const sourceFile = snapshot.sourcePath ?? '';
      if (path.resolve(sourceFile) !== path.resolve(target)) {
        const bytes = fs.readFileSync(snapshot.path);
        if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) {
          throw new Error('sealed attachment digest mismatch');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        try {
          fs.copyFileSync(sourceFile + MISSION_TRANSCRIPT_SUFFIX, target + MISSION_TRANSCRIPT_SUFFIX);
        } catch {
          // sem transcrição vizinha
        }
      }
      staged.push(relative);
    } catch (error) {
      console.warn(
        '[mission-attachments] cópia para o escopo de execução falhou:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return staged;
}
