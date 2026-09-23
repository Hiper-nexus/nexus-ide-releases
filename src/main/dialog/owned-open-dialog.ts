import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';

/**
 * Electron 43 runs IFileDialog::Show on a background COM thread. Passing the
 * BrowserWindow HWND (the UI thread) makes the shell view stop pumping on
 * Windows 11: within a few seconds the title gains "(Não está respondendo)"
 * and the list stays on "Nenhum item corresponde à pesquisa". Show(NULL)
 * stays responsive. Disabling the owner recreates the same hang, so the
 * dialog is not modal on Windows.
 */
export async function showOwnedOpenDialog(
  owner: BrowserWindow | null,
  options: OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  if (process.platform === 'win32') {
    return dialog.showOpenDialog(options);
  }
  return owner && !owner.isDestroyed()
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options);
}
