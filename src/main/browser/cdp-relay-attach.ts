import type { WebContents } from 'electron';
import {
  createCdpRelayConnection,
  type CdpRelayConnection,
  type CdpRelayTarget,
} from './cdp-relay';

/**
 * Plug do CdpRelay no Electron (próxima onda após o protocolo puro).
 *
 * Liga `webContents.debugger` ao `createCdpRelayConnection`: o servidor de
 * ambiente (Playwright) fala CDP com este relay e ele encaminha para o
 * debugger do tab. Electron permite UM cliente de debugger por webContents —
 * este relay compartilha o attach que o preview manager já tem.
 *
 * Protocolo: `Target.createCdpRelay` / `Target.attachCdpRelay` (chamados pelo
 * preview-server); mensagem vai por `write`.
 */

export interface CdpRelayAttachOptions {
  readonly write: (message: string) => void;
  /** Teto de download que o servidor pediu; `null` restaura o padrão. */
  readonly onDownloadDirectory?: (directory: string | null) => void;
}

export interface CdpRelayAttach {
  readonly connection: CdpRelayConnection;
  /** Desliga o debugger se este relay o attachou. */
  readonly detach: () => void;
  readonly attached: boolean;
}

interface DebuggerLease {
  count: number;
  /** Este processo chamou `attach`. O preview manager que já estava ligado não solta. */
  ownedByRelay: boolean;
}

const debuggerLeases = new WeakMap<object, DebuggerLease>();

function retainDebugger(
  webContents: object,
  debuggerApi: {
    isAttached: () => boolean;
    attach: (protocolVersion: string) => void;
  },
): DebuggerLease {
  const existing = debuggerLeases.get(webContents);
  if (existing) {
    existing.count += 1;
    return existing;
  }
  let ownedByRelay = false;
  if (!debuggerApi.isAttached()) {
    try {
      debuggerApi.attach('1.3');
      ownedByRelay = true;
    } catch {
      // Já attachado por outra origem: o relay compartilha o attach.
    }
  }
  const lease: DebuggerLease = { count: 1, ownedByRelay };
  debuggerLeases.set(webContents, lease);
  return lease;
}

function releaseDebugger(
  webContents: object,
  debuggerApi: { detach: () => void },
  lease: DebuggerLease,
): void {
  lease.count -= 1;
  if (lease.count > 0) return;
  debuggerLeases.delete(webContents);
  if (!lease.ownedByRelay) return;
  try {
    debuggerApi.detach();
  } catch {
    // Já detachado pelo preview manager.
  }
}

/** Converte o `debugger` do Electron no `CdpRelayTarget`. */
function targetFromWebContents(
  webContents: WebContents,
  onDownloadDirectory?: (directory: string | null) => void,
): CdpRelayTarget {
  return {
    send: (method, params, sessionId) =>
      webContents.debugger.sendCommand(method, params, sessionId),
    // O targetId estável do tab: `Target.getTargetInfo` do próprio debugger
    // devolve o id real do Chromium; aqui usamos o id do WebContents como
    // fallback quando o debugger ainda não respondeu.
    targetId: async () => {
      try {
        const info = (await webContents.debugger.sendCommand(
          'Target.getTargetInfo',
        )) as { targetInfo?: { targetId?: string } };
        if (info?.targetInfo?.targetId) return info.targetInfo.targetId;
      } catch {
        // Debugger ainda não attachado ou comando não suportado.
      }
      return `webcontents-${webContents.id}`;
    },
    url: () => {
      try {
        return webContents.getURL();
      } catch {
        return '';
      }
    },
    title: () => {
      try {
        return webContents.getTitle();
      } catch {
        return '';
      }
    },
    userAgent: () => {
      try {
        return webContents.getUserAgent();
      } catch {
        return 'NexusIDE';
      }
    },
    setDownloadDirectory: (directory) => {
      onDownloadDirectory?.(directory);
    },
  };
}

/**
 * Attach do relay ao `webContents`. Se já houver um debugger attachado,
 * compartilha (Electron permite um cliente). O `write` recebe as mensagens
 * CDP para o servidor de ambiente.
 */
export function attachCdpRelay(
  webContents: WebContents,
  options: CdpRelayAttachOptions,
): CdpRelayAttach {
  const target = targetFromWebContents(
    webContents,
    options.onDownloadDirectory,
  );
  const connection = createCdpRelayConnection(target, options.write);
  const debuggerApi = webContents.debugger;
  const lease = retainDebugger(webContents, debuggerApi);
  const onMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ) => {
    connection.event(method, params, sessionId);
  };
  debuggerApi.on('message', onMessage);
  let released = false;
  return {
    connection,
    attached: debuggerApi.isAttached(),
    detach: () => {
      if (released) return;
      released = true;
      try {
        debuggerApi.removeListener('message', onMessage);
      } catch {
        // Debugger já destruído.
      }
      releaseDebugger(webContents, debuggerApi, lease);
    },
  };
}
