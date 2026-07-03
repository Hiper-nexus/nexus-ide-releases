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

export const LAYOUT_CHANNELS = {
  save: 'layout:save',
  load: 'layout:load',
} as const;

export const ADAPTER_CHANNELS = {
  list: 'adapter:list',
  changed: 'adapter:changed',
} as const;
