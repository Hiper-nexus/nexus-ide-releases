import { shell } from 'electron';
import { z } from 'zod';
import { MEDIA_NO_PROJECT_ERROR } from '../../shared/media-types';
import {
  MEDIA_REFERENCE_CHANNELS,
  MEDIA_REFERENCE_MAX_BYTES,
  type MediaReferenceInfo,
  type MediaReferenceSaveResult,
} from '../../shared/media-reference-types';
import { handleTrusted } from '../security/trusted-ipc';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  listReferences,
  readReferenceDataUrl,
  removeReference,
  saveReference,
} from './media-references';

/**
 * IPC das referências do Estúdio (F-1611). Só a janela principal fala aqui
 * (`handleTrusted`): o canal grava arquivo no projeto. O Main nunca recebe
 * um caminho de origem para copiar — recebe os bytes que a pessoa escolheu,
 * arrastou ou colou —, então o renderer não consegue puxar para o projeto um
 * arquivo do disco que ela não deu.
 */

const MAX_BYTES = Math.max(...Object.values(MEDIA_REFERENCE_MAX_BYTES));

/** O clone estruturado do Electron entrega `ArrayBuffer` ou `Uint8Array`. */
const bytesSchema = z.custom<ArrayBuffer | Uint8Array>(
  (value) => value instanceof ArrayBuffer || value instanceof Uint8Array,
);

const savePayload = z.object({
  name: z.string().min(1).max(255),
  data: bytesSchema,
});

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  return data instanceof Uint8Array
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(data);
}

const storageKeyPayload = z.object({
  storageKey: z.string().min(1).max(512),
});

export function registerMediaReferenceIpc(): void {
  handleTrusted(MEDIA_REFERENCE_CHANNELS.list, (event): MediaReferenceInfo[] | null => {
    const scope = getRendererWorkspaceScope(event.sender);
    return scope ? listReferences(scope.rootRealPath) : null;
  });

  handleTrusted(MEDIA_REFERENCE_CHANNELS.save, (event, raw): MediaReferenceSaveResult => {
    const parsed = savePayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    // Acima do maior teto nem vira Buffer: a recusa com a frase certa (por
    // tipo) vem de `saveReference`, aqui só fecha a porta do que é absurdo.
    if (parsed.data.data.byteLength > MAX_BYTES + 1) {
      return { ok: false, error: 'Arquivo grande demais para referência.' };
    }
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
    try {
      return saveReference(scope.rootRealPath, parsed.data.name, toBuffer(parsed.data.data));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handleTrusted(MEDIA_REFERENCE_CHANNELS.remove, async (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
    try {
      return await removeReference(scope.rootRealPath, parsed.data.storageKey, (abs) =>
        shell.trashItem(abs),
      );
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handleTrusted(MEDIA_REFERENCE_CHANNELS.readDataUrl, (event, raw) => {
    const parsed = storageKeyPayload.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'payload inválido' };
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) return { ok: false, error: MEDIA_NO_PROJECT_ERROR };
    return readReferenceDataUrl(scope.rootRealPath, parsed.data.storageKey);
  });
}
