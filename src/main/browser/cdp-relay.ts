/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream reference: apps/desktop/src/preview/CdpRelay.ts.
 * Nexus changes: Minimal per-tab CDP protocol/Target handling adapted to injected pure target/send/write callbacks; upstream Electron/transport construction is not copied.
 */
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

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const validSession = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0-\x1f]/u.test(value);
const isCommand = (value: unknown): value is CdpCommand =>
  plainObject(value) && Number.isSafeInteger(value.id) &&
  typeof value.method === 'string' && value.method.length <= 128 &&
  /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(value.method) &&
  (value.params === undefined || plainObject(value.params)) &&
  (value.sessionId === undefined || validSession(value.sessionId));

const BROWSER_CONTEXT_ID = 'nexus-preview';
const ANNOUNCE = Symbol('announce');
const PAGE_SESSION_ID = 'nexus-preview-page';
// This retained protocol has no production transport. A future governed
// connection still needs a sensitive-field/visual contract for arbitrary JS.
const PAGE_METHODS = new Set([
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getLayoutMetrics',
  'Page.navigate', 'Page.reload',
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Runtime.runIfWaitingForDebugger',
  'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.describeNode',
  'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText',
  'Network.enable', 'Network.disable',
]);
const ACKNOWLEDGED = new Set(['Target.setDiscoverTargets', 'Browser.resetPermissions', 'Browser.cancelDownload']);

export interface CdpRelayAuthority {
  readonly assertCurrentAuthority?: () => void;
}

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
  authority: CdpRelayAuthority = {},
): CdpRelayConnection {
  const assertCurrent = () => authority.assertCurrentAuthority?.();
  const send = (message: Record<string, unknown>) => {
    try { assertCurrent(); write(JSON.stringify(message)); } catch { /* Revoked or closed consumer. */ }
  };
  const nativeSend = async (method: string, params: Record<string, unknown>, sessionId?: string) => {
    assertCurrent();
    const result = await target.send(method, params, sessionId);
    assertCurrent();
    return result;
  };
  let attached = false;
  const sessions = new Map<string, 'browser' | 'page'>([[PAGE_SESSION_ID, 'page']]);
  const children = new Map<string, {parent?: string; targetId: string}>();
  let sessionSequence = 0;
  const newSession = (kind: 'browser' | 'page') => {
    const sessionId = `nexus-preview-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  const sameOrigin = (url: string) => {
    try { return new URL(url).origin === new URL(target.url()).origin && /^(http|https):$/u.test(new URL(url).protocol); }
    catch { return false; }
  };
  const removeChild = (id: string) => {
    for (const [child, info] of children) if (info.parent === id) removeChild(child);
    children.delete(id);
  };
  const targetInfo = async () => {
    assertCurrent();
    const targetId = await target.targetId();
    assertCurrent();
    return {targetId, type:'page', title:target.title(), url:target.url(), attached:true, canAccessOpener:false, browserContextId:BROWSER_CONTEXT_ID};
  };
  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case 'Browser.setDownloadBehavior':
        if (command.params?.behavior !== 'deny' || command.params.downloadPath !== undefined) throw new Error('Downloads are not authorized for this relay.');
        return {}; // Main cancels downloads; no caller-selected directory or native policy change.
      case 'Browser.getVersion':
        return {protocolVersion:'1.3',product:'NexusIDE',revision:'',userAgent:target.userAgent(),jsVersion:''};
      case 'Target.getTargetInfo':
        if (command.params?.targetId !== undefined && command.params.targetId !== (await target.targetId())) throw new Error('Only this preview tab\'s page can be inspected.');
        assertCurrent();
        return {targetInfo:await targetInfo()};
      case 'Target.getBrowserContexts': return {browserContextIds:[BROWSER_CONTEXT_ID]};
      case 'Target.getTargets': return {targetInfos:[await targetInfo()]};
      case 'Target.attachToBrowserTarget': return {sessionId:newSession('browser')};
      case 'Target.attachToTarget':
        if (command.params?.targetId !== (await target.targetId())) throw new Error('Only this preview tab\'s page can be attached.');
        assertCurrent();
        return {sessionId:newSession('page')};
      case 'Target.detachFromTarget': {
        const id = command.params?.sessionId;
        if (!validSession(id) || (!sessions.has(id) && !children.has(id))) throw new Error('Unknown session.');
        if (id !== PAGE_SESSION_ID) sessions.delete(id);
        removeChild(id);
        return {};
      }
      case 'Target.setAutoAttach': {
        if (command.sessionId && (sessions.get(command.sessionId) === 'page' || children.has(command.sessionId))) {
          if (command.params?.flatten !== true || typeof command.params.autoAttach !== 'boolean' || typeof command.params.waitForDebuggerOnStart !== 'boolean') throw new Error('Unsupported child attachment policy.');
          return nativeSend('Target.setAutoAttach', {
            autoAttach:command.params.autoAttach, flatten:true, waitForDebuggerOnStart:command.params.waitForDebuggerOnStart,
            filter:[{type:'iframe',exclude:false},{type:'worker',exclude:false},{exclude:true}],
          }, children.has(command.sessionId) ? command.sessionId : undefined);
        }
        if (attached) return {};
        const info = await targetInfo();
        attached = true;
        return {[ANNOUNCE]:{method:'Target.attachedToTarget',params:{sessionId:PAGE_SESSION_ID,targetInfo:info,waitingForDebugger:false}}};
      }
      default: throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
    }
  };
  const pageCommand = async (command: CdpCommand): Promise<unknown> => {
    if (!PAGE_METHODS.has(command.method)) throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
    const child = children.has(command.sessionId!) ? command.sessionId : undefined;
    if (command.method === 'Page.navigate' && (typeof command.params?.url !== 'string' || !sameOrigin(command.params.url) || command.params.frameId !== undefined || child)) throw new Error('Navigation must stay in the selected preview page.');
    if (command.method === 'Runtime.runIfWaitingForDebugger' && child === undefined) return {};
    return nativeSend(command.method, command.params ?? {}, child);
  };
  return {
    receive: raw => {
      if (raw.length > 1024 * 1024) return;
      let command: unknown;
      try { command = JSON.parse(raw); } catch { return; }
      if (!isCommand(command)) return;
      const request = command;
      const route = request.sessionId === undefined ? {} : {sessionId:request.sessionId};
      // Async dispatch also catches a synchronous native/authority failure.
      void Promise.resolve().then(async () => {
        assertCurrent();
        if (request.sessionId !== undefined && !sessions.has(request.sessionId) && !children.has(request.sessionId)) throw new Error('Unknown session.');
        if (/^(Browser|Target)\./u.test(request.method)) return browserCommand(request);
        if (!request.sessionId || sessions.get(request.sessionId) === 'browser') throw new Error('A proved page session is required.');
        return pageCommand(request);
      }).then(value => {
        const announce = typeof value === 'object' && value !== null && ANNOUNCE in value ? (value as {[ANNOUNCE]:Record<string,unknown>})[ANNOUNCE] : undefined;
        send({id:request.id,result:announce ? {} : (value ?? {}),...route});
        if (announce) send(announce);
      }, cause => send({id:request.id,error:{code:-32000,message:cause instanceof Error ? cause.message : 'CDP command refused'},...route}));
    },
    event: (method, params, sessionId) => {
      try { assertCurrent(); } catch { return; }
      if (!attached || (sessionId !== undefined && !children.has(sessionId))) return;
      if (method === 'Target.attachedToTarget') {
        if (!plainObject(params) || !validSession(params.sessionId) || sessions.has(params.sessionId) || children.has(params.sessionId) || !plainObject(params.targetInfo)) return;
        const info = params.targetInfo;
        if ((info.type !== 'iframe' && info.type !== 'worker') || typeof info.url !== 'string' || !sameOrigin(info.url) || typeof info.targetId !== 'string' || !validSession(info.targetId)) return;
        children.set(params.sessionId,{parent:sessionId,targetId:info.targetId});
      } else if (method === 'Target.detachedFromTarget' && plainObject(params) && validSession(params.sessionId)) {
        removeChild(params.sessionId);
      } else if (method === 'Target.targetDestroyed' && plainObject(params)) {
        for (const [id, info] of children) if (info.targetId === params.targetId) removeChild(id);
      }
      if (method.startsWith('Browser.download')) { send({method,params}); return; }
      if (sessionId) { send({method,params,sessionId}); return; }
      for (const [id,kind] of sessions) if (kind === 'page') send({method,params,sessionId:id});
    },
  };
}
