import { BrowserWindow, dialog } from 'electron';

/**
 * Helper único para diálogos nativos (não-forjáveis) de confirmação. Antes
 * disto, deep-link.ts (confirmOpenPath / confirmLicenseApply) e remote-bridge.ts
 * carregavam cada um seu próprio scaffolding de showMessageBox — a cópia repetida
 * de defaultId/cancelId/noLink é o tipo de coisa que diverge silenciosamente e
 * enfraquece o fail-closed. Centraliza aqui o contrato de segurança.
 */

export interface NativeConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  /** Rótulo do botão de confirmação (botão 1). O botão 0 é sempre "Cancelar". */
  confirmLabel: string;
}

/**
 * Diálogo nativo SÍNCRONO de confirmação. O botão 0 ("Cancelar") é o
 * default/cancel — fail-closed: fechar o diálogo ou Esc nega. Retorna true só se
 * o usuário clicou no botão de confirmação.
 *
 * Nota: remote-bridge usa a variante ASSÍNCRONA com guarda de serialização e
 * timeout (dialog-storm de device malicioso) e por isso não passa por aqui.
 */
export function confirmNativeAction(
  opts: NativeConfirmOptions,
  win?: BrowserWindow | null,
): boolean {
  const boxOpts = {
    type: 'warning' as const,
    buttons: ['Cancelar', opts.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    noLink: true,
  };
  const res = win
    ? dialog.showMessageBoxSync(win, boxOpts)
    : dialog.showMessageBoxSync(boxOpts);
  return res === 1;
}
