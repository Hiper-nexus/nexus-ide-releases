import type {
  ShotFileKind,
  ShotFilesReceivedPayload,
} from '../../shared/shot-bridge';
import type { NexusApi } from '../../shared/types';
import { useToastStore } from './toast-store';
import { useLayoutStore } from './layout-store';
import { listPanes } from '../lib/split-tree';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import { getActiveWorkspacePath } from './active-workspace';
import {
  fileUrlForPath,
  toAbsoluteContextPath,
} from '../lib/mission-shell-file-intake';

/**
 * Última milha do shot-bridge (F-576/F-613). O Main valida os caminhos (realpath
 * sob ~/Pictures|Movies/Nexus Shot, ou Imagens|Vídeos no Windows), foca a janela e emite
 * "shot:files-received".
 *
 * Além de exibir o toast de confirmação com ação Abrir/Abrir pasta, os arquivos
 * recebidos são automaticamente injetados no pane de terminal/agente ativo
 * (estagiados em mission-context se possível, ou usando o caminho real validado),
 * permitindo que agentes como Antigravity, Claude, Codex ou Grok vejam e
 * analisem a captura imediatamente no prompt.
 */

export type ShotIngestAppApi = Pick<
  NexusApi['app'],
  'onShotFilesReceived' | 'openTerminalPath'
> & {
  files?: Pick<NexusApi['files'], 'importDroppedUri'>;
  writeToPane?: (paneId: string, data: string) => boolean;
  resolveTargetPaneId?: () => string | null;
  getActiveWorkspacePath?: () => string | null;
};

const KIND_LABEL: Record<ShotFileKind, string> = {
  image: 'imagem',
  video: 'vídeo',
  other: 'arquivo',
};

export function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function parentDirOf(path: string): string {
  // O Main devolve o realpath nativo: C:\…\Nexus Shot\x.png no Windows.
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '';
}

function batchDetail(files: ShotFilesReceivedPayload['files']): string {
  const shown = files
    .slice(0, 3)
    .map((file) => file.name)
    .join(', ');
  const rest = files.length - 3;
  return rest > 0 ? `${shown} e mais ${rest}` : shown;
}

/**
 * Seleciona arquivos prioritários para colar no prompt do terminal.
 * Em pacotes de gravação do Nexus Shot (vídeo + contact-sheet + até centenas de frames),
 * prioriza a folha de contato e o vídeo, evitando despejar dezenas de caminhos no prompt.
 */
export function selectShotFilesToInject(
  files: ShotFilesReceivedPayload['files'],
): ShotFilesReceivedPayload['files'] {
  if (files.length <= 1) return files;
  const videos = files.filter((f) => f.kind === 'video');
  const sheets = files.filter(
    (f) =>
      f.name.toLowerCase().includes('contact-sheet') ||
      f.name.toLowerCase().includes('contact'),
  );
  const others = files.filter(
    (f) =>
      f.kind !== 'video' &&
      !f.name.toLowerCase().includes('contact-sheet') &&
      !f.name.toLowerCase().includes('contact'),
  );

  const selected: ShotFilesReceivedPayload['files'] = [];
  if (sheets.length > 0) selected.push(...sheets);
  if (videos.length > 0) selected.push(...videos);

  const maxTotal = 3;
  for (const other of others) {
    if (selected.length >= maxTotal) break;
    selected.push(other);
  }

  return selected.length > 0 ? selected : files.slice(0, maxTotal);
}

/**
 * Identifica o pane alvo que deve receber a injeção do shot:
 * 1. Pane com foco do operador (se tiver sessão PTY viva);
 * 2. Primeiro agente CLI vivo no grid;
 * 3. Qualquer outro terminal vivo.
 */
export function resolveShotTargetPaneId(): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const panes = listPanes(root);
  if (focusedPaneId && getPaneSessionId(focusedPaneId)) {
    return focusedPaneId;
  }
  const liveAgent = panes.find(
    (p) => p.kind === 'cli-agent' && Boolean(getPaneSessionId(p.id)),
  );
  if (liveAgent) return liveAgent.id;
  const live = panes.find((p) => Boolean(getPaneSessionId(p.id)));
  return live?.id ?? null;
}

async function stageFile(
  file: ShotFilesReceivedPayload['files'][number],
  filesApi?: Pick<NexusApi['files'], 'importDroppedUri'>,
  workspacePath?: string | null,
): Promise<string> {
  if (filesApi?.importDroppedUri) {
    try {
      const uri = fileUrlForPath(file.path);
      const res = await filesApi.importDroppedUri(uri);
      if (res.ok && res.path) {
        return toAbsoluteContextPath(workspacePath ?? null, res.path);
      }
    } catch {
      // Fallback para o caminho validado no disco
    }
  }
  return file.path;
}

async function openShotPath(
  api: ShotIngestAppApi,
  path: string,
): Promise<void> {
  const res = await api.openTerminalPath(path);
  if (!res.ok) {
    useToastStore
      .getState()
      .push('error', 'Não deu para abrir o arquivo do Shot', {
        detail: res.error,
      });
  }
}

/** Assina o push do Main; devolve o unsubscribe (padrão initDevServerStore). */
export function initShotIngestToasts(
  api: ShotIngestAppApi = window.nexus?.app,
): () => void {
  if (!api?.onShotFilesReceived) return () => {};
  return api.onShotFilesReceived(async (payload) => {
    const files = payload.files;
    if (files.length === 0) return;
    const { push } = useToastStore.getState();
    const dedupeKey = `shot-ingest:${payload.receivedAt}`;

    const filesApi =
      api.files ??
      (typeof window !== 'undefined' ? window.nexus?.files : undefined);
    const targetPaneResolver =
      api.resolveTargetPaneId ?? resolveShotTargetPaneId;
    const paneWriter = api.writeToPane ?? writeToPane;
    const workspaceGetter =
      api.getActiveWorkspacePath ?? getActiveWorkspacePath;

    const targetPaneId = targetPaneResolver();
    let injectedCount = 0;

    if (targetPaneId) {
      const toInject = selectShotFilesToInject(files);
      const stagedPaths: string[] = [];
      const workspacePath = workspaceGetter();
      for (const file of toInject) {
        const staged = await stageFile(file, filesApi, workspacePath);
        stagedPaths.push(staged);
      }
      if (stagedPaths.length > 0) {
        const line = stagedPaths.map(shellQuote).join(' ') + ' ';
        const ok = paneWriter(targetPaneId, line);
        if (ok) injectedCount = stagedPaths.length;
      }
    }

    if (files.length === 1) {
      const file = files[0];
      const injectedHint = injectedCount > 0 ? ' · colado no terminal' : '';
      push('success', `Nexus Shot: ${file.name}`, {
        detail: `${KIND_LABEL[file.kind]} · ${formatBytes(file.size)}${injectedHint}`,
        action: {
          label: 'Abrir',
          onClick: () => void openShotPath(api, file.path),
        },
        dedupeKey,
      });
      return;
    }

    const first = files[0];
    const rest = files.length - injectedCount;
    const injectedHint =
      injectedCount > 0
        ? ` (${injectedCount} no terminal${rest > 0 ? `, +${rest} na pasta` : ''})`
        : '';
    push('success', `Nexus Shot: ${files.length} arquivos recebidos`, {
      detail: `${batchDetail(files)}${injectedHint}`,
      action: {
        label: 'Abrir pasta',
        onClick: () => void openShotPath(api, parentDirOf(first.path) || first.path),
      },
      dedupeKey,
    });
  });
}
