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
  const parent = nativeDialogParent(win);
  const res = parent
    ? dialog.showMessageBoxSync(parent, boxOpts)
    : dialog.showMessageBoxSync(boxOpts);
  return res === 1;
}

/**
 * A janela à qual o diálogo pode ser preso. No Linux/Wayland o Chromium exporta
 * a superfície da janela-mãe (xdg-foreign) para o diálogo GTK; uma janela ainda
 * não exibida não tem papel de toplevel e o compositor responde com erro de
 * protocolo fatal (`zxdg_exporter_v2: surface must be an xdg_toplevel`) — o app
 * inteiro cai. Acontecia no arranque a frio por `nexus://open` ou
 * `nexus://license`, quando a janela principal ainda está com `show: false`
 * (F-731). Nesse caso o diálogo sai sem janela-mãe; continua síncrono e
 * fail-closed.
 */
export function nativeDialogParent<W extends DialogParentWindow>(
  win: W | null | undefined,
  platform: NodeJS.Platform = process.platform,
): W | undefined {
  if (!win || win.isDestroyed()) return undefined;
  if (platform === 'linux' && !win.isVisible()) return undefined;
  return win;
}

interface DialogParentWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
}
