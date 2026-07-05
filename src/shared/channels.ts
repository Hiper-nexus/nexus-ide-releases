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
} as const;
