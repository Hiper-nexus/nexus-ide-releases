/**
 * IPC channel names for the orchestration domain (squads / missions /
 * handoffs / todos / pane registry / MCP info). Dependency-free so the
 * sandboxed preload can import it.
 */

export const ORCH_CHANNELS = {
  // Renderer → main
  panesSync: 'orch:panes.sync',
  paneSpawnResult: 'orch:pane.spawnResult',
  missionsList: 'orch:missions.list',
  handoffsList: 'orch:handoffs.list',
  todosGet: 'orch:todos.get',
  squadsList: 'orch:squads.list',
  squadSave: 'orch:squads.save',
  squadDelete: 'orch:squads.delete',
  squadExport: 'orch:squads.export',
  squadImport: 'orch:squads.import',
  mcpInfo: 'orch:mcp.info',
  catalogIndex: 'orch:catalog.index',
  catalogInstall: 'orch:catalog.install',
  catalogInstalled: 'orch:catalog.installed',
  toolsList: 'orch:tools.list',
  pluginsList: 'orch:plugins.list',
  hooksList: 'orch:hooks.list',

  // Main → renderer
  paneSpawnRequest: 'orch:pane.spawnRequest',
  paneCloseRequest: 'orch:pane.closeRequest',
  missionsChanged: 'orch:missions.changed',
  handoffsChanged: 'orch:handoffs.changed',
  todosChanged: 'orch:todos.changed',
  squadsChanged: 'orch:squads.changed',
} as const;
