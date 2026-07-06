/**
 * IPC channel names for the orchestration domain (squads / missions /
 * handoffs / todos / pane registry / MCP info). Dependency-free so the
 * sandboxed preload can import it.
 */

export const ORCH_CHANNELS = {
  // Renderer → main
  panesSync: 'orch:panes.sync',
  paneSpawnResult: 'orch:pane.spawnResult',
  browserOpenResult: 'orch:browser.openResult',
  missionsList: 'orch:missions.list',
  missionPanesList: 'orch:missions.panes',
  missionRebind: 'orch:missions.rebind',
  missionUpdate: 'orch:missions.update',
  missionRemove: 'orch:missions.remove',
  handoffsList: 'orch:handoffs.list',
  todosGet: 'orch:todos.get',
  todoSetStatus: 'orch:todos.setStatus',
  squadsList: 'orch:squads.list',
  squadDesign: 'orch:squads.design',
  squadSave: 'orch:squads.save',
  squadDelete: 'orch:squads.delete',
  squadExport: 'orch:squads.export',
  squadImport: 'orch:squads.import',
  mcpInfo: 'orch:mcp.info',
  catalogIndex: 'orch:catalog.index',
  catalogInstall: 'orch:catalog.install',
  recipeOverlay: 'orch:recipe.overlay',
  catalogOverlaySave: 'orch:catalog.overlaySave',
  recipePropose: 'orch:recipe.propose',
  agentSpecWrite: 'orch:agentSpec.write',
  catalogInstalled: 'orch:catalog.installed',
  toolsList: 'orch:tools.list',
  pluginsList: 'orch:plugins.list',
  hooksList: 'orch:hooks.list',

  // Main → renderer
  paneSpawnRequest: 'orch:pane.spawnRequest',
  browserOpenRequest: 'orch:browser.openRequest',
  paneCloseRequest: 'orch:pane.closeRequest',
  missionsChanged: 'orch:missions.changed',
  handoffsChanged: 'orch:handoffs.changed',
  todosChanged: 'orch:todos.changed',
  squadsChanged: 'orch:squads.changed',
} as const;
