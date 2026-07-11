/**
 * Canonical IPC channel names. Kept in a dependency-free module so both the
 * sandboxed preload and the main process can import them without pulling in
 * zod or node-only code.
 */

export const PTY_CHANNELS = {
  spawn: 'pty:spawn',
  write: 'pty:write',
  resize: 'pty:resize',
  kill: 'pty:kill',
  data: 'pty:data',
  exit: 'pty:exit',
  stateChange: 'pty:stateChange',
} as const;

export const BROWSER_CHANNELS = {
  create: 'browser:create',
  destroy: 'browser:destroy',
  bounds: 'browser:bounds',
  load: 'browser:load',
  back: 'browser:back',
  forward: 'browser:forward',
  reload: 'browser:reload',
  stop: 'browser:stop',
  state: 'browser:state',
  /** invoke: renderer → main. Toggle the in-page design-mode picker. */
  designMode: 'browser:designMode',
  /** event: main → renderer. Validated design event (selection/mode) of an
   * owned pane — the page→main leg rides browser:design-event no preload. */
  designEvent: 'browser:designEvent',
  /** invoke: renderer → main. Push the current selection context into an
   * agent CLI pane's PTY ("enviar seleção pro agente"). */
  designSend: 'browser:designSend',
  /** invoke: renderer → main. Optimistic style preview in the page (F2). */
  designPreview: 'browser:designPreview',
  /** invoke: renderer → main. Clear one/all style previews of a pane (F2). */
  designPreviewClear: 'browser:designPreviewClear',
} as const;

export const DEV_SERVER_CHANNELS = {
  /** event: main → renderer. A PTY pane announced a local dev-server URL. */
  detected: 'devserver:detected',
} as const;

export const DESIGN_WRITEBACK_CHANNELS = {
  /** invoke: renderer → main. Status do write-back p/ o workspace ativo. */
  status: 'design:status',
  start: 'design:start',
  stop: 'design:stop',
  action: 'design:action',
  undo: 'design:undo',
  redo: 'design:redo',
} as const;

export const PERF_CHANNELS = {
  snapshot: 'perf:snapshot',
} as const;

export const MCP_CHANNELS = {
  invoke: 'mcp:invoke',
  confirm: 'mcp:confirm',
  clearSession: 'mcp:clearSession',
} as const;

export const LAYOUT_CHANNELS = {
  save: 'layout:save',
  load: 'layout:load',
} as const;

export const ADAPTER_CHANNELS = {
  list: 'adapter:list',
  changed: 'adapter:changed',
} as const;

export const AGENT_HOOK_CHANNELS = {
  /** invoke: provider hook status → pane activity (never evidence). */
  ingestStatus: 'agent-hook:ingestStatus',
} as const;

export const WINDOW_CHANNELS = {
  /** send: renderer → main. React committed its first frame (fired from a
   * post-commit effect). The main-process mount watchdog waits for this to
   * distinguish "page loaded" from "app actually rendered" — in dev AND in
   * the packaged app, where a boot crash used to leave a black window. */
  mounted: 'renderer:mounted',
  /** send: main → preload. Runs the isolated packaged functional probes only
   * after React has mounted during --smoke-test. Never emitted in normal use. */
  functionalSmokeRun: 'smoke:functional:run',
  /** send: preload → main. Closed-schema probe evidence; no subsystem output. */
  functionalSmokeResult: 'smoke:functional:result',
  /** event: main → renderer. Deep link/document open (nexus://open ou
   * abrir-com): { path, isDir }. O renderer abre o workspace (ou o do pai). */
  deepOpenPath: 'app:deepOpenPath',
  /** invoke: renderer → main. Open a trusted https URL in the OS browser. */
  openExternal: 'app:openExternal',
  /** invoke: renderer → main. Inicia o login OAuth: o main gera o nonce
   * local (binding do deep link) e abre o browser — o renderer nunca monta
   * a URL de auth. */
  authLogin: 'auth:login',
  /**
   * invoke: renderer → main. Open packaged THIRD_PARTY_NOTICES.md (or LICENSE)
   * in the OS default app so closed-source builds still surface MIT/third-party
   * attribution without making the GitHub repo public.
   */
  openLegalNotices: 'app:openLegalNotices',
} as const;

export const TEAM_CHANNELS = {
  get: 'team:get',
  join: 'team:join',
  invite: 'team:invite',
  remove: 'team:removeMember',
  leave: 'team:leave',
} as const;
