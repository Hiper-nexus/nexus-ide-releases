/**
 * Ligação entre o preview loopback e o CdpRelay de um pane.
 *
 * O servidor de preview não importa o browser manager (ciclo). O manager
 * registra o abridor na carga do processo; sem registro o endpoint fecha.
 */

export interface PreviewCdpScope {
  readonly projectId: string;
  readonly checkoutId: string;
}

export interface PreviewCdpSession {
  readonly connection: {
    receive: (raw: string) => void;
  };
  readonly detach: () => void;
}

export interface PreviewCdpBridge {
  open(
    scope: PreviewCdpScope,
    paneId: string,
    previewOrigin: string,
    write: (message: string) => void,
  ): PreviewCdpSession | null;
  solePaneId(scope: PreviewCdpScope, previewOrigin: string): string | null;
}

let bridge: PreviewCdpBridge | null = null;

export function registerPreviewCdpBridge(next: PreviewCdpBridge | null): void {
  bridge = next;
}

export function previewCdpBridge(): PreviewCdpBridge | null {
  return bridge;
}
