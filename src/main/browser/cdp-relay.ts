/**
 * CdpRelay (item T3 `apps/desktop/src/preview/CdpRelay.ts` @ 26285ab).
 *
 * Apresenta o debugger de UM preview tab como endpoint CDP mínimo, para que o
 * servidor de ambiente (Playwright) conduza o `webview` do desktop com o
 * mesmo motor das abas headless. Só a página do tab é alcançável: comandos de
 * browser que o Playwright manda ao conectar são respondidos aqui; comandos de
 * página vão para o debugger do tab.
 *
 * Casca pura (sem Electron): `target.send`/`event`/`write` são injetados.
 */

export interface CdpRelayTarget {
  /** Sends a command to the tab's page, or to a child session such as an iframe. */
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
  readonly userAgent: () => string;
  /**
   * Where the server wants this tab's downloads, named by their CDP guid.
   * `null` restores the default.
   */
  readonly setDownloadDirectory: (directory: string | null) => void;
}

export interface CdpRelayConnection {
  /** Feed one message from the server. */
  readonly receive: (raw: string) => void;
  /** Feed one debugger event from the tab. */
  readonly event: (
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ) => void;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'number' &&
  typeof (value as { method?: unknown }).method === 'string';

const BROWSER_CONTEXT_ID = 'nexus-preview';
/** Marks an event to send right after a command's reply. */
const ANNOUNCE = Symbol('announce');
/** The page's root session id, as Playwright sees it. */
const PAGE_SESSION_ID = 'nexus-preview-page';

/** Browser-level commands that only need acknowledging for a page the desktop owns. */
const ACKNOWLEDGED = new Set([
  'Target.setDiscoverTargets',
  'Browser.grantPermissions',
  'Browser.resetPermissions',
  'Browser.cancelDownload',
]);

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
): CdpRelayConnection {
  const send = (message: Record<string, unknown>) => write(JSON.stringify(message));
  let attached = false;
  /**
   * Sessions this relay invented. Extra page sessions (Playwright's
   * `newCDPSession`) all reach the one real debugger session, so each gets the
   * page's events; other ids are the page's own child sessions, such as iframes.
   */
  const sessions = new Map<string, 'browser' | 'page'>([[PAGE_SESSION_ID, 'page']]);
  let sessionSequence = 0;
  const newSession = (kind: 'browser' | 'page') => {
    const sessionId = `nexus-preview-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  const targetInfo = async () => ({
    targetId: await target.targetId(),
    type: 'page',
    title: target.title(),
    url: target.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case 'Browser.setDownloadBehavior': {
        const directory = command.params?.['downloadPath'];
        const allowed =
          command.params?.['behavior'] !== 'deny' && typeof directory === 'string';
        target.setDownloadDirectory(allowed ? directory : null);
        const { browserContextId: _ignored, ...params } = command.params ?? {};
        return target.send('Browser.setDownloadBehavior', params, undefined);
      }
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'NexusIDE',
          revision: '',
          userAgent: target.userAgent(),
          jsVersion: '',
        };
      case 'Target.getTargetInfo':
        return {
          targetInfo: {
            targetId: 'browser',
            type: 'browser',
            title: '',
            url: '',
            attached: true,
            canAccessOpener: false,
          },
        };
      case 'Target.getBrowserContexts':
        return { browserContextIds: [BROWSER_CONTEXT_ID] };
      case 'Target.getTargets':
        return { targetInfos: [await targetInfo()] };
      case 'Target.attachToBrowserTarget':
        return { sessionId: newSession('browser') };
      case 'Target.attachToTarget': {
        const targetId = command.params?.['targetId'];
        if (targetId !== (await target.targetId()))
          throw new Error('Only this preview tab\'s page can be attached.');
        return { sessionId: newSession('page') };
      }
      case 'Target.detachFromTarget': {
        const sessionId = command.params?.['sessionId'];
        if (typeof sessionId === 'string' && sessionId !== PAGE_SESSION_ID)
          sessions.delete(sessionId);
        return {};
      }
      case 'Target.setAutoAttach': {
        if (attached) return {};
        attached = true;
        // The page is announced once, right after this reply, as Chromium does.
        const info = await targetInfo();
        return {
          [ANNOUNCE]: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: PAGE_SESSION_ID,
              targetInfo: info,
              waitingForDebugger: false,
            },
          },
        };
      }
      default:
        throw new Error(
          `Not supported for a desktop preview tab: ${command.method}`,
        );
    }
  };

  const pageCommand = (command: CdpCommand): Promise<unknown> => {
    const child =
      sessions.get(command.sessionId!) === 'page' ? undefined : command.sessionId;
    // The page itself is already running, but its child frames are not:
    // Playwright auto-attaches with waitForDebuggerOnStart, so Chromium pauses
    // every new cross-site iframe and worker until this reaches it.
    if (command.method === 'Runtime.runIfWaitingForDebugger' && child === undefined) {
      return Promise.resolve({});
    }
    return target.send(command.method, command.params ?? {}, child);
  };

  return {
    receive: (raw) => {
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const result =
        command.sessionId === undefined ||
        sessions.get(command.sessionId) === 'browser'
          ? browserCommand(command)
          : pageCommand(command);
      const route =
        command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      // Replies leave as commands finish, as Chromium's do, so a slow command
      // such as a screenshot never holds up the ones behind it.
      void result.then(
        (value) => {
          const announce =
            typeof value === 'object' && value !== null && ANNOUNCE in value
              ? (value as { [ANNOUNCE]: Record<string, unknown> })[ANNOUNCE]
              : undefined;
          send({ id: command.id, result: announce ? {} : (value ?? {}), ...route });
          if (announce) send(announce);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      );
    },
    event: (method, params, sessionId) => {
      if (!attached) return;
      // Download events are the browser's; Playwright listens on its root session.
      if (method.startsWith('Browser.download')) {
        send({ method, params });
        return;
      }
      // Electron reports the page's own events with an empty session id.
      if (sessionId) {
        send({ method, params, sessionId });
        return;
      }
      for (const [id, kind] of sessions)
        if (kind === 'page') send({ method, params, sessionId: id });
    },
  };
}
