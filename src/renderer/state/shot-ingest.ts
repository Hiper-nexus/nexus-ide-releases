import type {
  ShotFileKind,
  ShotFilesReceivedPayload,
} from '../../shared/shot-bridge';
import type { NexusApi } from '../../shared/types';
import { useToastStore } from './toast-store';

/**
 * Última milha do shot-bridge (F-576). O Main valida os caminhos (realpath
 * sob ~/Pictures|Movies/Nexus Shot), foca a janela e emite
 * "shot:files-received" — sem consumidor no renderer, o "Enviar para o
 * NexusIDE" do Shot não produzia nada visível dentro do app. Superfície
 * mínima: toast de confirmação com ação Abrir, que passa pelo
 * openTerminalPath (a validação de caminho continua no Main).
 */

export type ShotIngestAppApi = Pick<
  NexusApi['app'],
  'onShotFilesReceived' | 'openTerminalPath'
>;

const KIND_LABEL: Record<ShotFileKind, string> = {
  image: 'imagem',
  video: 'vídeo',
  other: 'arquivo',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function parentDirOf(path: string): string {
  const cut = path.lastIndexOf('/');
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
  api: ShotIngestAppApi = window.nexus.app,
): () => void {
  return api.onShotFilesReceived((payload) => {
    const files = payload.files;
    if (files.length === 0) return;
    const { push } = useToastStore.getState();
    const dedupeKey = `shot-ingest:${payload.receivedAt}`;
    if (files.length === 1) {
      const file = files[0];
      push('success', `Nexus Shot: ${file.name}`, {
        detail: `${KIND_LABEL[file.kind]} · ${formatBytes(file.size)}`,
        action: {
          label: 'Abrir',
          onClick: () => void openShotPath(api, file.path),
        },
        dedupeKey,
      });
      return;
    }
    const first = files[0];
    push('success', `Nexus Shot: ${files.length} arquivos recebidos`, {
      detail: batchDetail(files),
      action: {
        label: 'Abrir pasta',
        onClick: () => void openShotPath(api, parentDirOf(first.path) || first.path),
      },
      dedupeKey,
    });
  });
}
