/**
 * Referências do Estúdio de Mídia (F-1611): imagens, logos e vídeos de
 * exemplo que a pessoa traz para usar na geração — imagem a editar, primeiro
 * quadro, referência de personagem/estilo, logo do vídeo de apresentação.
 *
 * Os arquivos são COPIADOS para a pasta do projeto aberto
 * (`media/referencias/`), nunca lidos de onde estavam: o Main só grava bytes
 * que o renderer já tem (escolhidos, arrastados ou colados pela pessoa) e o
 * gerador lê de dentro do workspace, como todo input de mídia.
 */

export type MediaReferenceKind = 'image' | 'video';

/** Pasta das referências, relativa à raiz do projeto (POSIX). */
export const MEDIA_REFERENCE_DIR = 'media/referencias';

/**
 * Teto por arquivo. Os bytes atravessam o IPC por clone estruturado; vídeo de
 * exemplo acima disso é longo demais para servir de referência a um modelo.
 */
export const MEDIA_REFERENCE_MAX_BYTES: Readonly<Record<MediaReferenceKind, number>> = {
  image: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

export interface MediaReferenceInfo {
  /** Caminho relativo ao projeto (POSIX), dentro de `media/referencias/`. */
  storageKey: string;
  /** Nome para mostrar (o nome original, sem o prefixo de unicidade). */
  name: string;
  kind: MediaReferenceKind;
  bytes: number;
  /**
   * SVG: serve de logo no vídeo por código, mas os modelos de imagem e vídeo
   * só aceitam bitmap — o Estúdio não o manda para eles.
   */
  vector: boolean;
  addedAt: number;
}

export type MediaReferenceSaveResult =
  | { ok: true; reference: MediaReferenceInfo }
  | { ok: false; error: string };

export const MEDIA_REFERENCE_CHANNELS = {
  list: 'media:listReferences',
  save: 'media:saveReference',
  remove: 'media:removeReference',
  readDataUrl: 'media:readReferenceDataUrl',
} as const;

export interface MediaReferencesApi {
  /** `null` sem projeto aberto: as referências moram na pasta do projeto. */
  list(): Promise<MediaReferenceInfo[] | null>;
  save(name: string, data: ArrayBuffer): Promise<MediaReferenceSaveResult>;
  /** Manda para a Lixeira (recuperável), nunca apaga direto. */
  remove(storageKey: string): Promise<{ ok: boolean; error?: string }>;
  readDataUrl(storageKey: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
}
