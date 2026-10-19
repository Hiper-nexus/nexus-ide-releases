import type { ProductDestination } from '../state/product-navigation-store';
import { normalizeProjectContextPath } from '../state/mission-setup-store';
import {
  classifyMissionAttachment,
  MISSION_ATTACHMENT_LIMITS,
  stageMissionAttachmentWithLocation,
} from './mission-attachments';
import { hasSkillDragType } from './pane-interactions';
import { platformCopy } from './platform-copy';

/**
 * Shell-wide file drop is only for starting or filling the setup wizard.
 * An open pane/mission keeps the event; navigating back to Express was a
 * hijack ("Arquivo fora do projeto" after a live paste/drop).
 */
export function shellClaimsMissionFileDrop(
  destinationKind: ProductDestination['kind'],
): boolean {
  return destinationKind === 'launcher' || destinationKind === 'mission-setup';
}

export function droppedProjectContextPath(
  workspacePath: string,
  file: File,
): string | null {
  const absolutePath = window.nexus.files.pathForFile(file);
  if (!absolutePath) return null;

  const root = workspacePath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const candidate = absolutePath.replaceAll('\\', '/');
  const caseInsensitive = /^[A-Za-z]:\//u.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCandidate = caseInsensitive
    ? candidate.toLowerCase()
    : candidate;
  const prefix = `${comparableRoot}/`;
  if (!comparableCandidate.startsWith(prefix)) return null;
  return normalizeProjectContextPath(candidate.slice(root.length + 1));
}

/** Caminho absoluto em qualquer SO (POSIX, UNC e letra de unidade). */
export function isAbsoluteContextPath(candidate: string): boolean {
  return isAbsolutePath(candidate);
}

function isAbsolutePath(candidate: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(candidate);
}

/**
 * F-582: `file://` de um caminho absoluto, independente do host. `encodeURI`
 * sozinho quebrava em `#`/`?` (o `fileURLToPath` do Main perdia o fragmento
 * → "Arquivo não encontrado") e caminhos win32 `C:\…` não viravam URL
 * válida. Normaliza as barras, garante a `/` inicial (drive vira `/C:/…`) e
 * escapa `?`/`#` por cima do encodeURI.
 */
export function fileUrlForPath(absolutePath: string): string {
  let normalized = absolutePath.replaceAll('\\', '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return `file://${encodeURI(normalized).replace(/[?#]/g, (c) =>
    encodeURIComponent(c),
  )}`;
}

/**
 * Converte caminhos relativos (como `.nexus/attachments/...` ou `src/...`)
 * em caminhos absolutos do sistema de arquivos quando um diretório-base
 * (workspace ou cwd do pane) está disponível. O terminal e prompts de agentes
 * CLI precisam de caminhos absolutos para que LLMs (como Claude Code ou Kimi)
 * nunca confundam `.nexus/...` com pastas na home do usuário (`~/.nexus/`).
 */
export function toAbsoluteContextPath(
  baseDir: string | null | undefined,
  targetPath: string,
): string {
  if (!baseDir || isAbsolutePath(targetPath)) return targetPath;
  const root = baseDir.replaceAll('\\', '/').replace(/\/+$/u, '');
  const rel = targetPath.replaceAll('\\', '/').replace(/^\/+/u, '');
  return `${root}/${rel}`;
}

export function partitionDroppedMissionFiles(
  workspacePath: string,
  files: readonly File[],
): {
  readonly inProject: string[];
  readonly toImport: File[];
  readonly rejected: File[];
} {
  const inProject: string[] = [];
  const toImport: File[] = [];
  const rejected: File[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relative = droppedProjectContextPath(workspacePath, file);
    if (relative) {
      if (!seen.has(relative)) {
        seen.add(relative);
        inProject.push(relative);
      }
      continue;
    }
    if (classifyMissionAttachment(file)) {
      toImport.push(file);
      continue;
    }
    rejected.push(file);
  }

  return { inProject, toImport, rejected };
}

/**
 * In-project files stay as relative context. External files are copied into
 * `.nexus/attachments/mission-context/` so agents can read them without a
 * sandbox grant on `~/.nexus/dropped`.
 *
 * O PANE aceita QUALQUER tipo ("pane deve sempre aceitar", 19/08): a cópia de
 * bytes é inofensiva e o agente decide o que fazer com o arquivo. O único
 * limite é físico — o cap de 14 MB por arquivo evita ler um blob gigante na
 * memória do renderer (o main já recusa payloads acima do teto dele).
 */
export type DroppedPathResolution =
  | {
      readonly ok: true;
      readonly path: string;
      /**
       * Onde o arquivo está, quando se sabe com certeza: o caminho absoluto
       * que o Main gravou (anexo estagiado) ou o do próprio arquivo dentro da
       * pasta pedida. É este que se digita no pane (F-760).
       */
      readonly absolutePath?: string;
    }
  | { readonly ok: false; readonly error: string };

/** Motivo honesto de uma recusa do intake do pane — nunca conteúdo. */
function intakeErrorMessage(file: Pick<File, 'name'>, error: unknown): string {
  const name = file.name.trim() || 'anexo';
  if (error instanceof DOMException) {
    return `"${name}" não pôde ser lido pelo Nexus (${error.name}): salve no disco e arraste do ${platformCopy().fileManager}.`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `"${name}" não pôde ser copiado: ${reason}`;
}

export async function resolveDroppedMissionContextPath(
  workspacePath: string | null,
  file: File,
): Promise<DroppedPathResolution> {
  if (workspacePath && workspacePath.length > 0) {
    const relative = droppedProjectContextPath(workspacePath, file);
    if (relative) {
      return {
        ok: true,
        path: relative,
        absolutePath: toAbsoluteContextPath(workspacePath, relative),
      };
    }
  }
  if (file.size > MISSION_ATTACHMENT_LIMITS.maxBytesPerFile) {
    return { ok: false, error: droppedFileRejectionMessage(file) };
  }
  try {
    const staged = await stageMissionAttachmentWithLocation(file, { allowAnyKind: true });
    return {
      ok: true,
      path: staged.attachment.path,
      ...(staged.absolutePath ? { absolutePath: staged.absolutePath } : {}),
    };
  } catch (error) {
    // F-582: o catch mudo escondia o motivo real (leitura do File, IPC) —
    // era isso que fazia o bug "voltar" depois de cada correção parcial.
    return { ok: false, error: intakeErrorMessage(file, error) };
  }
}

/** Mensagem honesta do toast quando o intake do pane recusa um drop. */
export function droppedFileRejectionMessage(file: Pick<File, 'name' | 'size'>): string {
  const name = file.name.trim() || 'anexo';
  if (file.size > MISSION_ATTACHMENT_LIMITS.maxBytesPerFile) {
    return `"${name}" excede o limite de 14 MB por arquivo.`;
  }
  return `"${name}" não pôde ser copiado para a missão.`;
}

/** O que veio num arraste, quando `dataTransfer.files` chegou vazia. */
export type DroppedPayload = {
  readonly types?: ArrayLike<string> | readonly string[];
  readonly getData?: (type: string) => string;
  readonly files?: ArrayLike<unknown>;
};

/** Linhas úteis de um `text/uri-list`: uma por endereço, `#` é comentário. */
function uriListLines(raw: string): string[] {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) lines.push(trimmed);
  }
  return lines;
}

function firstUri(transfer: DroppedPayload): string {
  return uriListLines(transfer.getData?.('text/uri-list') ?? '')[0] ?? '';
}

/** Endereço aproveitável de um arraste sem `File`: caminho local ou link web. */
export type DroppedUri = {
  readonly kind: 'file' | 'url';
  readonly uri: string;
};

export type DropUriResolution = {
  readonly accepted: readonly DroppedUri[];
  readonly rejected: readonly string[];
};

function classifyDroppedUri(uri: string): DroppedUri['kind'] | null {
  if (/^file:/i.test(uri)) return 'file';
  if (/^https?:\/\//i.test(uri)) return 'url';
  return null;
}

/**
 * O que dá para aproveitar quando `files` veio vazia: o `text/uri-list`, o
 * flavor `DownloadURL` do Chromium (promessa de mídia arrastada de apps
 * Electron/web — é assim que o WhatsApp Desktop entrega imagem), um
 * `text/plain` que seja UM link http(s) ou um caminho absoluto local.
 *
 * O `file://` NÃO é decodificado aqui — o main faz isso com `fileURLToPath`,
 * que também valida o host. Esquemas fora de file/http(s) (data:, blob:,
 * javascript:) ficam em `rejected` só para o diagnóstico; o main recusa de
 * novo por conta própria, sem confiar nesta triagem.
 */
export function resolveDropUris(
  transfer: DroppedPayload | null | undefined,
): DropUriResolution {
  if (!transfer) return { accepted: [], rejected: [] };
  const candidates: string[] = [
    ...uriListLines(transfer.getData?.('text/uri-list') ?? ''),
  ];
  if (candidates.length === 0) {
    // DownloadURL: "mime:filename:url" — o flavor de promessa de download do
    // Chromium. A 3ª parte (depois do 2º ':') é o endereço real.
    const downloadUrl = (transfer.getData?.('DownloadURL') ?? '').trim();
    const match = /^[-\w.+]+\/[-\w.+]+:[^:]*:(https?:\/\/\S+)$/i.exec(
      downloadUrl,
    );
    if (match) candidates.push(match[1]!);
  }
  if (candidates.length === 0) {
    const text = (transfer.getData?.('text/plain') ?? '').trim();
    if (/^https?:\/\/\S+$/i.test(text)) {
      candidates.push(text);
    } else if (/^\/\S/.test(text) && !text.includes('\n')) {
      // Caminho absoluto local (cache de mídia de apps nativos). Espaços
      // precisam de encode para virar um file:// válido no main.
      candidates.push(`file://${encodeURI(text)}`);
    }
  }
  const accepted: DroppedUri[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const uri of candidates) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const kind = classifyDroppedUri(uri);
    if (kind) accepted.push({ kind, uri });
    else rejected.push(uri);
  }
  return { accepted, rejected };
}

/**
 * Versão do `resolveDropUris` para PASTE: só `text/uri-list` e o flavor
 * `DownloadURL` — NUNCA o fallback `text/plain`. A assimetria é deliberada:
 * no drop, um link/caminho solto como texto já chegou como gesto de arquivo;
 * no paste, uma URL ou `/abs/path` digitada é TEXTO que o usuário quer no
 * terminal — interceptá-la baixaria/copiaria algo que ninguém pediu.
 */
export function pasteUrisFromClipboard(
  transfer: DroppedPayload | null | undefined,
): DroppedUri[] {
  if (!transfer) return [];
  const candidates: string[] = [
    ...uriListLines(transfer.getData?.('text/uri-list') ?? ''),
  ];
  if (candidates.length === 0) {
    // DownloadURL: "mime:filename:url" — mesmo regex do resolveDropUris.
    const downloadUrl = (transfer.getData?.('DownloadURL') ?? '').trim();
    const match = /^[-\w.+]+\/[-\w.+]+:[^:]*:(https?:\/\/\S+)$/i.exec(
      downloadUrl,
    );
    if (match) candidates.push(match[1]!);
  }
  const accepted: DroppedUri[] = [];
  const seen = new Set<string>();
  for (const uri of candidates) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const kind = classifyDroppedUri(uri);
    if (kind) accepted.push({ kind, uri });
  }
  return accepted;
}

/**
 * O pasteboard anuncia conteúdo que vale interceptar (ou ao menos diagnosticar
 * com toast)? Espelha `acceptsShellDrag` sem a guarda de skill-drag: `Files`,
 * `text/uri-list`, `DownloadURL`, ou `text/html` SEM `text/plain` (mídia
 * embutida — a mesma exceção F-526 do drop). `text/plain` sozinho nunca
 * anuncia payload: é texto que segue para o terminal.
 */
export function clipboardAnnouncesPayload(types: ArrayLike<string>): boolean {
  const list = Array.from(types);
  if (
    list.includes('Files') ||
    list.includes('text/uri-list') ||
    list.includes('DownloadURL')
  ) {
    return true;
  }
  return list.includes('text/html') && !list.includes('text/plain');
}

/**
 * Mensagem para o paste que NÃO trouxe arquivo — mesma lógica do
 * `describeDropWithoutFiles` com a redação de colagem ("colou"/"cole").
 */
export function describePasteWithoutFiles(
  transfer: DroppedPayload | null | undefined,
): string {
  if (!transfer) {
    return `A área de transferência chegou vazia. Salve o arquivo no disco e copie/cole do ${platformCopy().fileManager}.`;
  }
  const types = Array.from(transfer.types ?? []);
  const uri = firstUri(transfer);

  if (uri.startsWith('file://')) {
    let decoded = uri.slice('file://'.length);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Caminho com escape inválido: melhor mostrar cru do que nada.
    }
    return `Veio o endereço do arquivo, não o arquivo: ${decoded}`;
  }
  if (uri !== '') return `Veio um link, não um arquivo: ${uri}`;

  if (types.includes('Files')) {
    return `O app de origem prometeu um arquivo que o Nexus não recebeu (tipos: ${types.join(', ')}). Salve a mídia no disco e copie/arraste do ${platformCopy().fileManager}.`;
  }

  const text = transfer.getData?.('text/plain')?.trim() ?? '';
  if (text !== '') return 'Veio só texto na colagem, sem arquivo.';

  return `A colagem não trouxe arquivo. Salve a mídia no disco e copie/arraste do ${platformCopy().fileManager}.`;
}

/** Motivo genérico quando o main recusa sem explicar (não deveria acontecer). */
export function droppedUriRejectionMessage(dropped: DroppedUri): string {
  return dropped.kind === 'url'
    ? 'O link não pôde ser baixado para a missão.'
    : 'O arquivo não pôde ser copiado para a missão.';
}

/**
 * Mensagem para o arraste que NÃO trouxe arquivo.
 *
 * O drop do pane devolvia silêncio quando `files` vinha vazia, e é assim que a
 * maioria dos apps nativos entrega mídia: uma PROMESSA de arquivo no
 * pasteboard, que o Chromium só materializa em alguns casos. Sem aviso, "não
 * suportado" e "quebrado" ficam idênticos para quem está usando.
 */
export function describeDropWithoutFiles(
  transfer: DroppedPayload | null | undefined,
): string {
  if (!transfer) {
    return `O arraste chegou vazio. Salve o arquivo no disco e arraste do ${platformCopy().fileManager}.`;
  }
  const types = Array.from(transfer.types ?? []);
  const uri = firstUri(transfer);

  if (uri.startsWith('file://')) {
    let decoded = uri.slice('file://'.length);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Caminho com escape inválido: melhor mostrar cru do que nada.
    }
    return `Veio o endereço do arquivo, não o arquivo: ${decoded}`;
  }
  if (uri !== '') return `Veio um link, não um arquivo: ${uri}`;

  if (types.includes('Files')) {
    return `O app de origem prometeu um arquivo que o Nexus não recebeu (tipos: ${types.join(', ')}). Salve a mídia no disco e arraste do ${platformCopy().fileManager}.`;
  }

  const text = transfer.getData?.('text/plain')?.trim() ?? '';
  if (text !== '') return 'Veio só texto no arraste, sem arquivo.';

  return `O arraste não trouxe arquivo. Salve a mídia no disco e arraste do ${platformCopy().fileManager}.`;
}

/**
 * O arraste merece ser aceito no `dragover`?
 *
 * Só `types` é legível aqui: durante o `dragover` o data store está em
 * "protected mode" e `getData()` devolve sempre string vazia. Decidir por
 * `getData` seria decidir no escuro.
 *
 * - `text/plain` sozinho NÃO entra: arrastar texto selecionado para dentro de
 *   uma textarea é gesto legítimo, e reivindicar esse drop mata a inserção
 *   nativa (`App` não faz mais `preventDefault` no topo do handler).
 * - O arraste interno de skill também não: sem esta guarda o overlay global
 *   acende enquanto se arrasta uma skill pelo app.
 */
export function acceptsShellDrag(types: ArrayLike<string>): boolean {
  if (hasSkillDragType(types)) return false;
  const list = Array.from(types);
  if (
    list.includes('Files') ||
    list.includes('text/uri-list') ||
    list.includes('DownloadURL')
  ) {
    return true;
  }
  // F-526: WhatsApp e apps Electron anunciam a mídia arrastada apenas como
  // `text/html` (imagem embutida em data:URI) — sem isto o dragover não faz
  // preventDefault e o navegador NUNCA entrega o drop. Texto formatado de
  // página (html + plain juntos) continua fora do intake.
  return list.includes('text/html') && !list.includes('text/plain');
}

/** O que o shell deve fazer com um arraste que chegou. */
export type ShellDropPlan =
  | { readonly action: 'files' }
  | { readonly action: 'uris'; readonly uris: readonly DroppedUri[] }
  | { readonly action: 'warn'; readonly message: string }
  | { readonly action: 'ignore' };

/**
 * Decide o destino de um arraste ANTES de qualquer `preventDefault`.
 *
 * `allowUrlDownload` falso é o caso do wizard: baixar um http(s) disparado por
 * um arraste seria surpreendente e a lista branca do wizard não aceitaria o
 * arquivo resultante — melhor dizer o que chegou.
 */
export function describeShellDrop(
  transfer: DroppedPayload | null | undefined,
  options: { readonly allowUrlDownload: boolean } = {
    allowUrlDownload: false,
  },
): ShellDropPlan {
  if (!transfer) return { action: 'ignore' };
  const types = Array.from(transfer.types ?? []);
  if (hasSkillDragType(types)) return { action: 'ignore' };
  if ((transfer.files?.length ?? 0) > 0) return { action: 'files' };

  const accepted = resolveDropUris(transfer).accepted.filter(
    (dropped) => options.allowUrlDownload || dropped.kind === 'file',
  );
  if (accepted.length > 0) return { action: 'uris', uris: accepted };

  // F-526: mídia embutida em HTML (WhatsApp/Electron) — o onDrop materializa
  // o File a partir do data:URI e segue a rota de arquivos.
  if (embeddedImageFromHtml(transfer.getData?.('text/html') ?? null)) {
    return { action: 'files' };
  }

  if (types.includes('Files') || types.includes('text/uri-list')) {
    return { action: 'warn', message: describeDropWithoutFiles(transfer) };
  }
  return { action: 'ignore' };
}

/**
 * Único ponto do renderer que copia/baixa um endereço arrastado para o
 * mission-context. O pane também usa `importDroppedUri`, mas escreve o
 * caminho no PTY — por isso ele mantém o próprio wrapper.
 */
export async function importDroppedUriForMission(
  uri: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const kind: DroppedUri['kind'] = /^file:/i.test(uri) ? 'file' : 'url';
  const fallback = droppedUriRejectionMessage({ kind, uri });
  try {
    const result = await window.nexus.files.importDroppedUri(uri);
    if (result.ok && result.path) return { ok: true, path: result.path };
    return { ok: false, message: result.error ?? fallback };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : fallback,
    };
  }
}

// ── F-526: imagem embutida em HTML (WhatsApp e apps Electron) ────────────────

const DATA_URI_IMAGE =
  /src=["']data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)["']/i;

export interface EmbeddedImage {
  readonly mime: string;
  readonly base64: string;
}

/**
 * WhatsApp e outros apps Electron entregam mídia arrastada/colada como HTML
 * com um data:URI de imagem, sem File materializado e sem uri-list — os dois
 * caminhos que o intake já cobria. Este é o terceiro: extrair a imagem
 * embutida do HTML.
 */
export function embeddedImageFromHtml(html: string | null | undefined): EmbeddedImage | null {
  if (!html) return null;
  const match = DATA_URI_IMAGE.exec(html);
  if (!match) return null;
  return { mime: match[1]!.toLowerCase(), base64: match[2]! };
}

/** Extensão canônica do mime da imagem embutida. */
export function embeddedImageExtension(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

/**
 * Materializa a imagem embutida como File, pronta para a MESMA rota de
 * paste/drop (stage no mission-context + path absoluto no prompt).
 */
export function fileFromEmbeddedImage(
  image: EmbeddedImage,
  now = Date.now(),
): File | null {
  try {
    const binary = atob(image.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const name = `imagem-colada-${new Date(now).toISOString().replace(/[:.]/g, '-')}.${embeddedImageExtension(image.mime)}`;
    return new File([bytes], name, {
      type: image.mime === 'image/jpg' ? 'image/jpeg' : image.mime,
      lastModified: now,
    });
  } catch {
    return null;
  }
}
