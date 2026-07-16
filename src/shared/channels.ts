/**
 * Canonical IPC channel names. Kept in a dependency-free module so both the
 * sandboxed preload and the main process can import them without pulling in
 * zod or node-only code.
 */

export const PTY_CHANNELS = {
  spawn: 'pty:spawn',
  write: 'pty:write',
  writeConfirmed: 'pty:write-confirmed',
  resize: 'pty:resize',
  kill: 'pty:kill',
  data: 'pty:data',
  acknowledge: 'pty:acknowledge',
  recover: 'pty:recover',
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
  /** invoke: renderer → main. Pin an annotation on the current selection
   * (comment + intent) — the main snapshots the validated selection. */
  designAnnotate: 'browser:designAnnotate',
  /** invoke: renderer → main. List the pane's annotations (summaries). */
  designAnnotations: 'browser:designAnnotations',
  /** invoke: renderer → main. Delete one annotation by id. */
  designAnnotationDelete: 'browser:designAnnotationDelete',
  /** invoke: renderer → main. Clear all annotations of a pane. */
  designAnnotationsClear: 'browser:designAnnotationsClear',
  /** invoke: renderer → main. Ship ALL annotations as one consolidated
   * design-feedback prompt into an agent CLI pane (or dry-run for copy). */
  designAnnotationsSend: 'browser:designAnnotationsSend',
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

/** Terminal CommandBlock contextual actions (re-run / copy / handoff / …). */
export const TERMINAL_BLOCK_CHANNELS = {
  action: 'terminal-block:action',
  /** invoke: list recent blocks for a pane/session (in-memory tracker). */
  list: 'terminal-block:list',
} as const;

/** Unified SearchMixer IPC. */
export const SEARCH_MIXER_CHANNELS = {
  search: 'search-mixer:search',
} as const;

/**
 * Product-wave IPC (memory, skills, MCP hub, autonomy, editor, flags).
 * Mirrors PRODUCT_WAVE_CHANNELS in main/product-wave-ipc.ts — keep in sync.
 */
export const PRODUCT_WAVE_CHANNELS = {
  flagsList: 'product:flags.list',
  memoryList: 'product:memory.list',
  memoryRemember: 'product:memory.remember',
  memorySearch: 'product:memory.search',
  memoryBacklinks: 'product:memory.backlinks',
  memoryComplete: 'product:memory.complete',
  skillsList: 'product:skills.list',
  skillsLockRead: 'product:skills.lockRead',
  skillsLockWrite: 'product:skills.lockWrite',
  mcpHubLoad: 'product:mcpHub.load',
  mcpHubSave: 'product:mcpHub.save',
  mcpHubDrift: 'product:mcpHub.drift',
  mcpHubHealth: 'product:mcpHub.health',
  mcpHubRollback: 'product:mcpHub.rollback',
  mcpHubObserve: 'product:mcpHub.observe',
  mcpHubSyncPlan: 'product:mcpHub.syncPlan',
  mcpHubSyncApply: 'product:mcpHub.syncApply',
  autonomyDecide: 'product:autonomy.decide',
  searchQuery: 'product:search.query',
  editorOpen: 'product:editor.open',
  editorApply: 'product:editor.apply',
} as const;

/**
 * Descoberta universal de configs de ecossistemas de agente (read-only).
 * Registrado em main/discovery/discovery-ipc.ts.
 */
export const DISCOVERY_CHANNELS = {
  /** invoke: renderer → main. Inventário do workspace: MCP servers,
   * context/rule files, skills e slash commands, com source/level/path. */
  workspaceConfigs: 'discovery:workspace-configs',
} as const;

/**
 * Memória agentic por workspace (entrega C2). Leitura (stats/recall) + a única
 * mutação forget. Registrado em main/memory/memory-ipc.ts.
 */
export const MEMORY_CHANNELS = {
  /** invoke: bank stats (por kind/scope, ativas, recalls). */
  stats: 'memory:stats',
  /** invoke: recall FTS5 { query, limit?, kind? }. */
  recall: 'memory:recall',
  /** invoke: esquece uma memória por id (tombstone auditável). */
  forget: 'memory:forget',
} as const;

/**
 * Metadado rico de modelo (preço/janela/capacidades). Read-only; registrado em
 * main/adapters/model-metadata-ipc.ts.
 */
export const MODEL_CHANNELS = {
  /** invoke: renderer → main. Metadado rico de um modelo (preço/janela). */
  richMetadata: 'model:richMetadata',
} as const;

/** Agent lifecycle observability (record / list / reap finished only). */
export const AGENT_LIFECYCLE_CHANNELS = {
  record: 'agent-lifecycle:record',
  list: 'agent-lifecycle:list',
  reap: 'agent-lifecycle:reap',
} as const;

export const MCP_CHANNELS = {
  invoke: 'mcp:invoke',
  confirm: 'mcp:confirm',
  clearSession: 'mcp:clearSession',
} as const;

export const LAYOUT_CHANNELS = {
  save: 'layout:save',
  saveSync: 'layout:saveSync',
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
