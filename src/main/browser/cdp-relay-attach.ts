/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/desktop/src/preview/CdpRelay.ts.
 * Nexus changes: Nexus Electron debugger wrapper with actual attached result, owned/borrowed debugger lease cleanup and listeners. Protocol implementation lives in cdp-relay; wrapper does not establish an endpoint.
 */
import type { WebContents } from 'electron';
import {
  createCdpRelayConnection,
  type CdpRelayConnection,
  type CdpRelayTarget,
} from './cdp-relay';

/** Internal Electron adapter for the retained per-page protocol.
 * No preview-server, WebSocket, or product endpoint calls this adapter.
 * It shares Main debugger leases; a future governed transport must enforce
 * the separate sensitive-field/visual authority contract before using it.
 */

export interface CdpRelayAttachOptions {
  readonly write: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
  /** Legacy callback only; this relay never changes native download policy. */
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
 * CDP do adapter interno, sem um transporte produtivo registrado.
 */
export function attachCdpRelay(
  webContents: WebContents,
  options: CdpRelayAttachOptions,
): CdpRelayAttach {
  let released = false;
  const assertCurrent = (): void => {
    if (released || options.signal?.aborted) throw new Error('browser relay authority revoked');
    options.assertCurrentAuthority?.();
  };
  assertCurrent();
  const target = targetFromWebContents(
    webContents,
    options.onDownloadDirectory,
  );
  const connection = createCdpRelayConnection(target, options.write, { assertCurrentAuthority: assertCurrent });
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
