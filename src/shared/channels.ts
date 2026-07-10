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
} as const;

export const TEAM_CHANNELS = {
  get: 'team:get',
  join: 'team:join',
  invite: 'team:invite',
  remove: 'team:removeMember',
  leave: 'team:leave',
} as const;
