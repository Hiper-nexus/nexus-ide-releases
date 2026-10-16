import { create } from 'zustand';
import { createImageThumbnailDataUrl } from '../lib/image-compression';
import { missionAttachmentDisplayName } from '../lib/mission-attachments';

/**
 * O que a tela sabe de cada anexo copiado nesta sessão (nome escolhido,
 * miniatura) e do que ainda está a caminho (anexando / falhou). Fica numa
 * store porque o anexo chega por dois donos: o picker (botão, drop na zona) e
 * o intake do shell (⌘V no campo de texto) — antes só o picker lembrava o
 * nome e a miniatura, então a imagem colada fora da zona não aparecia.
 */
export interface AttachmentPresentation {
  readonly name: string;
  readonly thumbnail?: string;
}

export interface PendingAttachment {
  readonly id: string;
  readonly name: string;
  readonly error?: string;
}

const PRESENTATION_LIMIT = 48;
let pendingSequence = 0;

interface State {
  presentation: ReadonlyMap<string, AttachmentPresentation>;
  pending: readonly PendingAttachment[];
}

export const useMissionAttachmentPresentation = create<State>(() => ({
  presentation: new Map(),
  pending: [],
}));

export function rememberAttachment(
  path: string,
  next: AttachmentPresentation,
): void {
  useMissionAttachmentPresentation.setState((state) => {
    const map = new Map(state.presentation);
    map.delete(path);
    map.set(path, next);
    while (map.size > PRESENTATION_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    return { presentation: map };
  });
}

/** Gera a miniatura sem bloquear o anexo: chega depois e redesenha a linha. */
export function rememberAttachmentThumbnail(path: string, file: Blob): void {
  void createImageThumbnailDataUrl(file).then((thumbnail) => {
    const known = useMissionAttachmentPresentation.getState().presentation.get(path);
    if (thumbnail && known) rememberAttachment(path, { ...known, thumbnail });
  });
}

export function attachmentDisplayName(path: string): string {
  return (
    useMissionAttachmentPresentation.getState().presentation.get(path)?.name ??
    missionAttachmentDisplayName(path)
  );
}

/** Marca um arquivo como "anexando…"; devolve o id para concluir ou falhar. */
export function beginPendingAttachment(name: string): string {
  pendingSequence += 1;
  const id = `pending-${pendingSequence}`;
  useMissionAttachmentPresentation.setState((state) => ({
    pending: [...state.pending, { id, name }],
  }));
  return id;
}

export function finishPendingAttachment(id: string): void {
  useMissionAttachmentPresentation.setState((state) => ({
    pending: state.pending.filter((item) => item.id !== id),
  }));
}

export function failPendingAttachment(id: string, error: string): void {
  useMissionAttachmentPresentation.setState((state) => ({
    pending: state.pending.map((item) =>
      item.id === id ? { ...item, error } : item,
    ),
  }));
}
