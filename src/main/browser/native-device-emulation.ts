import type { WebContents } from 'electron';

/**
 * Único ponto do Main que liga ou desliga a emulação de device nativa do
 * Electron (F-1656, F-1659).
 *
 * No Electron 43.8.3, `WebContents::EnableDeviceEmulation` e
 * `DisableDeviceEmulation` fazem `frame_host->GetView()->GetRenderWidgetHost()`
 * sem checar o `GetView()` (shell/browser/api/electron_api_web_contents.cc).
 * Sem RenderWidgetHostView o Main morre com SIGSEGV em null+0xf8. Os dois
 * estados sem view foram reproduzidos no Electron real:
 * - antes do primeiro documento commitar (pane recém-criado e escondido);
 * - depois que o renderer morre (crash, OOM, kill do macOS) e até o próximo
 *   commit.
 * Os outros métodos do WebContents que tocam a render view checam null.
 *
 * Quem chama informa se houve commit desde o último renderer vivo
 * (`documentCommitted`, zerado no `render-process-gone`). O `isCrashed()` cobre
 * a janela entre a morte do renderer e o evento chegar ao Main. Um teste trava
 * qualquer chamada direta fora deste arquivo.
 */
export type NativeDeviceEmulationParameters = Parameters<WebContents['enableDeviceEmulation']>[0];

export type NativeDeviceEmulationTarget = Pick<
  WebContents,
  'isDestroyed' | 'isCrashed' | 'enableDeviceEmulation' | 'disableDeviceEmulation'
>;

export function canDriveNativeDeviceEmulation(
  wc: Pick<WebContents, 'isDestroyed' | 'isCrashed'>,
  documentCommitted: boolean,
): boolean {
  return documentCommitted && !wc.isDestroyed() && !wc.isCrashed();
}

/** Liga a emulação nativa; devolve false quando não havia render view para recebê-la. */
export function enableNativeDeviceEmulation(
  wc: NativeDeviceEmulationTarget,
  documentCommitted: boolean,
  parameters: NativeDeviceEmulationParameters,
): boolean {
  if (!canDriveNativeDeviceEmulation(wc, documentCommitted)) return false;
  wc.enableDeviceEmulation(parameters);
  return true;
}

/** Desliga a emulação nativa; sem render view não há emulação viva para desligar. */
export function disableNativeDeviceEmulation(
  wc: NativeDeviceEmulationTarget,
  documentCommitted: boolean,
): boolean {
  if (!canDriveNativeDeviceEmulation(wc, documentCommitted)) return false;
  wc.disableDeviceEmulation();
  return true;
}
