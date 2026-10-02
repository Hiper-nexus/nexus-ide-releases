import { BUG_REPORT_CHANNELS } from '../../shared/bug-report-channels';
import type {
  BugReportPreviewResult,
  BugReportSubmitResult,
} from '../../shared/bug-report';
import { handleTrusted } from '../security/trusted-ipc';
import {
  createBugReportService,
  createDefaultBugReportServiceDeps,
  type BugReportService,
} from './bug-report-service';

/**
 * IPC do reporte de problema. As duas chamadas só aceitam o frame principal da
 * janela principal (`handleTrusted`); o payload é `unknown` até o schema estrito
 * do serviço aceitá-lo. O retorno é sempre um resultado tipado: nem um erro
 * inesperado vira exceção que carregue texto de falha para o renderer.
 */

const GENERIC_FAILURE = {
  ok: false,
  code: 'server',
  message: 'Não foi possível processar o relato agora. Tente de novo.',
} as const;

export function registerBugReportIpc(
  service: BugReportService = createBugReportService(createDefaultBugReportServiceDeps),
): void {
  handleTrusted(
    BUG_REPORT_CHANNELS.preview,
    async (_event, raw): Promise<BugReportPreviewResult> => {
      try {
        return await service.preview(raw);
      } catch {
        return { ...GENERIC_FAILURE };
      }
    },
  );
  handleTrusted(
    BUG_REPORT_CHANNELS.submit,
    async (_event, raw): Promise<BugReportSubmitResult> => {
      try {
        return await service.submit(raw);
      } catch {
        return { ...GENERIC_FAILURE };
      }
    },
  );
}

/** O que o pedido de abertura precisa da janela (estrutural: testável sem Electron). */
export interface BugReportWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: { isDestroyed(): boolean; send(channel: string): void };
}

/**
 * Menu "Ajuda → Reportar um problema…": traz a janela para a frente e pede ao
 * renderer que abra o diálogo. Não carrega dados — o diálogo nasce vazio.
 */
export function requestOpenBugReportDialog(win: BugReportWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (win.webContents.isDestroyed()) return false;
  win.webContents.send(BUG_REPORT_CHANNELS.open);
  return true;
}
