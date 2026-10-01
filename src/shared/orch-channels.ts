/**
 * IPC channel names for the orchestration domain (squads / missions /
 * handoffs / todos / pane registry / MCP info). Dependency-free so the
 * sandboxed preload can import it.
 */

export const ORCH_CHANNELS = {
  // Renderer → main
  panesSync: 'orch:panes.sync',
  /**
   * Teclado do operador num pane de missão. O renderer não escreve nesses
   * panes (fronteira de capacidade); ele PEDE, e o main valida posse, missão
   * viva e formato antes de escrever pelo lane main-owned.
   */
  paneOperatorInput: 'orch:panes.operatorInput',
  paneSpawnResult: 'orch:pane.spawnResult',
  paneRecoveryResult: 'orch:pane.recoveryResult',
  browserOpenResult: 'orch:browser.openResult',
  /** Strict canonical MissionEngine surface; scope is always derived in main. */
  missionPrepare: 'orch:mission.prepare',
  /** Router de intenção (Onda 3): classifica objetivo antes do prepare. */
  intentRoute: 'orch:intent.route',
  /** Resposta direta (Onda 3): responde pergunta trivial sem criar missão. */
  intentAnswer: 'orch:intent.answer',
  missionStart: 'orch:mission.start',
  missionCommand: 'orch:mission.command',
  missionSnapshot: 'orch:mission.snapshot',
  missionList: 'orch:mission.list',
  workspaceMissionList: 'orch:workspace-missions.list',
  missionsList: 'orch:missions.list',
  missionPanesList: 'orch:missions.panes',
  /** P1-0 slice 1: snapshot único do plano de controle (panes+fila+ownership+blocks). */
  missionControlPlane: 'orch:missions.controlPlane',
  /** Main-owned proof that one restored layout pane still has live mission authority. */
  missionPaneRestoreAuthority: 'orch:missions.paneRestoreAuthority',
  /** Retry the orchestrator bootstrap of a bootstrap-blocked mission. */
  missionResumeBootstrap: 'orch:missions.resumeBootstrap',
  /**
   * Promote lane=plan → standard after plan.md is ready so PREVC code work
   * is allowed (operator "Executar plano").
   */
  missionRebind: 'orch:missions.rebind',
  missionPromoteOrchestrator: 'orch:mission.promoteOrchestrator',
  /** "Tornar orquestrador" num pane solto: missão leve da aba, liderada por ele. */
  missionCreateForPane: 'orch:mission.createForPane',
  /** F-231: "+ Pane" → "Nesta missão" — worker aberto pela mão do operador. */
  missionSpawnOperatorPane: 'orch:mission.spawnOperatorPane',
  missionUpdate: 'orch:missions.update',
  /** Native-confirmed physical shutdown that preserves the durable mission. */
  missionCloseRuntime: 'orch:missions.closeRuntime',
  /** Operator archives a parked or finished mission as verified-complete. */
  missionCompleteByOperator: 'orch:missions.completeByOperator',
  missionRemove: 'orch:missions.remove',
  /** Mission event journal consumer (flag: feature.mission.eventJournal). */
  missionEventsRecent: 'orch:missionEvents.recent',
  missionEventsReplay: 'orch:missionEvents.replay',
  missionEventsAck: 'orch:missionEvents.ack',
  missionEventsCursor: 'orch:missionEvents.cursor',
  handoffsList: 'orch:handoffs.list',
  /** Answer one exact durable nexus_clarify question in this renderer scope. */
  clarifyAnswerSubmit: 'orch:clarify.answer',
  /** Human diff annotations persisted as a non-terminal mission handoff. */
  operatorReviewSubmit: 'orch:operatorReview.submit',
  todosGet: 'orch:todos.get',
  todoSetStatus: 'orch:todos.setStatus',
  todosClearBoard: 'orch:todos.clearBoard',
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
  harnessEnrich: 'orch:harness.enrich',
  harnessEnriched: 'orch:harness.enriched',
  toolsList: 'orch:tools.list',
  pluginsList: 'orch:plugins.list',
  hooksList: 'orch:hooks.list',
  designSystemsSearch: 'orch:designSystems.search',
  designSystemsImport: 'orch:designSystems.import',
  sessionLeaseInspect: 'orch:session.leaseInspect',

  // Main → renderer
  paneSpawnRequest: 'orch:pane.spawnRequest',
  /** Re-present one exact Main-owned live PTY; never authorizes a new spawn. */
  panePresentationRequest: 'orch:pane.presentationRequest',
  paneRecoveryRequest: 'orch:pane.recoveryRequest',
  browserOpenRequest: 'orch:browser.openRequest',
  paneCloseRequest: 'orch:pane.closeRequest',
  /** 0.76.45: main estacionou o pane (CLI encerrado, pane fica; acordar = spawn com resume). */
  paneParkRequest: 'orch:pane.parkRequest',
  missionChanged: 'orch:mission.changed',
  missionsChanged: 'orch:missions.changed',
  handoffsChanged: 'orch:handoffs.changed',
  todosChanged: 'orch:todos.changed',
  squadsChanged: 'orch:squads.changed',
  /** Background MCP task lifecycle (started / exited / killed). */
  bgTaskEvent: 'orch:bgTask.event',
  /** Login-stuck watchdog: pane stuck on a CLI login screen (or recovered). */
  paneLoginStuck: 'orch:pane.loginStuck',
  /**
   * Worker CLI failed to boot (kimi/agy/…); main already retried or needs
   * Claude/Codex. Renderer shows a civilian PT toast — not pet geometry.
   */
  workerSpawnFailed: 'orch:worker.spawnFailed',
  /**
   * Hook plane → renderer: agent is waiting for Enter / permission.
   * Transition-only on each source (semantic + orca); the renderer ORs them.
   */
  agentWaiting: 'orch:agent.waiting',
} as const;
