import type { ProductDestination } from '../state/product-navigation-store';
import { normalizeProjectContextPath } from '../state/mission-setup-store';
import {
  classifyMissionAttachment,
  MISSION_ATTACHMENT_LIMITS,
  stageMissionAttachment,
} from './mission-attachments';
import { hasSkillDragType } from './pane-interactions';

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
export async function resolveDroppedMissionContextPath(
  workspacePath: string | null,
  file: File,
): Promise<string | null> {
  if (workspacePath && workspacePath.length > 0) {
    const relative = droppedProjectContextPath(workspacePath, file);
    if (relative) return relative;
  }
  if (file.size > MISSION_ATTACHMENT_LIMITS.maxBytesPerFile) return null;
  try {
    return (await stageMissionAttachment(file, { allowAnyKind: true })).path;
  } catch {
    return null;
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
 * O que dá para aproveitar quando `files` veio vazia: o `text/uri-list` e,
 * na falta dele, um `text/plain` que seja exatamente UM link http(s).
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
  let candidates = uriListLines(transfer.getData?.('text/uri-list') ?? '');
  if (candidates.length === 0) {
    const text = (transfer.getData?.('text/plain') ?? '').trim();
    if (/^https?:\/\/\S+$/i.test(text)) candidates = [text];
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
    return 'O arraste chegou vazio. Salve o arquivo no disco e arraste do Finder.';
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
    return 'O app de origem prometeu um arquivo que o Nexus não recebeu. Salve a mídia no disco e arraste do Finder.';
  }

  const text = transfer.getData?.('text/plain')?.trim() ?? '';
  if (text !== '') return 'Veio só texto no arraste, sem arquivo.';

  return 'O arraste não trouxe arquivo. Salve a mídia no disco e arraste do Finder.';
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
  return list.includes('Files') || list.includes('text/uri-list');
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
