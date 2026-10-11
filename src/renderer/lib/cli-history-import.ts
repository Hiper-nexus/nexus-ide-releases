import type {
  CliHistoryImportCounts,
  CliHistoryImportResult,
} from '../../shared/cli-history';
import { useToastStore } from '../state/toast-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Importação do histórico das CLIs pelo renderer (F-1171): menu de comandos
 * do pane e paleta usam o mesmo caminho. O Main deriva o projeto da sessão
 * dona do pane; aqui só vai {sessionId, paneId}.
 */

const NO_TERMINAL = 'Abra um terminal deste projeto para importar o histórico';

export async function importCliHistoryForPane(
  paneId: string | null | undefined,
): Promise<CliHistoryImportResult> {
  const sessionId = paneId ? getPaneSessionId(paneId) : null;
  const api = window.nexus?.terminalBlock?.importCliHistory;
  if (!paneId || !sessionId || !api) return { ok: false, error: NO_TERMINAL };
  try {
    return await api({ sessionId, paneId });
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'Não foi possível importar o histórico',
    };
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Resumo legível das contagens, para o menu e o toast da paleta. */
export function describeCliHistoryImport(counts: CliHistoryImportCounts): string {
  const ignored = counts.skipped + counts.filesSkipped;
  if (counts.found === 0) {
    const base =
      counts.files === 0
        ? 'Nenhum transcript de CLI neste projeto'
        : `Nenhum comando de shell em ${plural(counts.files, 'transcript', 'transcripts')}`;
    return ignored > 0 ? `${base} · ${plural(ignored, 'ignorado', 'ignorados')}` : base;
  }
  const parts = [
    plural(counts.imported, 'importado', 'importados'),
    `${counts.duplicates} já no histórico`,
  ];
  if (ignored > 0) parts.push(plural(ignored, 'ignorado', 'ignorados'));
  const summary = `${parts.join(' · ')} (${plural(counts.files, 'arquivo', 'arquivos')})`;
  return counts.capped ? `${summary} · teto atingido` : summary;
}

/** Paleta: importa a partir do pane focado e responde por toast. */
export async function importCliHistoryWithToast(
  paneId: string | null | undefined,
): Promise<void> {
  const { push } = useToastStore.getState();
  const result = await importCliHistoryForPane(paneId);
  if (!result.ok || !result.counts) {
    push('warn', 'Histórico das CLIs', result.error ?? 'Não foi possível importar o histórico');
    return;
  }
  push('success', 'Histórico das CLIs', describeCliHistoryImport(result.counts));
}
