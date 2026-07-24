/**
 * IPC channel names for the orchestration domain (squads / missions /
 * handoffs / todos / pane registry / MCP info). Dependency-free so the
 * sandboxed preload can import it.
 */

export const ORCH_CHANNELS = {
  // Renderer → main
  panesSync: 'orch:panes.sync',
  paneSpawnResult: 'orch:pane.spawnResult',
  paneRecoveryResult: 'orch:pane.recoveryResult',
  browserOpenResult: 'orch:browser.openResult',
  missionsList: 'orch:missions.list',
  missionPanesList: 'orch:missions.panes',
  missionCreate: 'orch:missions.create',
  /** Native-confirmed, exact one-shot grant for Pet/legacy immediate launch. */
  missionAuthorizeImmediateSquad:
    'orch:missions.authorizeImmediateSquad',
  /** Intent-first: arm a squad mission shell without an orchestrator pane. */
  missionArm: 'orch:missions.arm',
  /** Intent-first: submit/compile a goal contract (bumps intentVersion). */
  missionSubmitIntent: 'orch:missions.submitIntent',
  /** Intent-first: authorize dispatch after plan approval. */
  missionApproveIntent: 'orch:missions.approveIntent',
  /**
   * Materialize the approved mission's first orchestrator in main. The
   * renderer sends only missionId; every runtime field comes from main stores.
   */
  missionBootstrapOrchestrator: 'orch:missions.bootstrapOrchestrator',
  /** Retry the orchestrator bootstrap of a bootstrap-blocked mission. */
  missionResumeBootstrap: 'orch:missions.resumeBootstrap',
  /** Re-arm a blocked mission (sanctioned resume) before pane restore. */
  missionRearm: 'orch:missions.rearm',
  /**
   * Promote lane=plan → standard after plan.md is ready so PREVC code work
   * is allowed (operator "Executar plano").
   */
  missionPromotePlanLane: 'orch:missions.promotePlanLane',
  /** Main-owned passive paste + finite idle→busy/output acceptance proof. */
  missionKickoffSubmit: 'orch:missions.kickoffSubmit',
  /** Bind a live orchestrator pane to an armed mission (no new mission row). */
  missionBindOrchestrator: 'orch:missions.bindOrchestrator',
  /**
   * Explicit "Preparar projeto": allow bounded context bootstrap while still
   * awaiting a real goal (does not dispatch workers).
   */
  missionPrepareProject: 'orch:missions.prepareProject',
  /** Cancel an executing prepare-project preflight without touching the mission. */
  missionCancelPreparation: 'orch:missions.cancelPreparation',
  /** Intent-first: prompt queue snapshot (executing / queued / cancelled). */
  missionPromptQueue: 'orch:missions.promptQueue',
  missionRebind: 'orch:missions.rebind',
  missionUpdate: 'orch:missions.update',
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

  // Main → renderer
  paneSpawnRequest: 'orch:pane.spawnRequest',
  paneRecoveryRequest: 'orch:pane.recoveryRequest',
  browserOpenRequest: 'orch:browser.openRequest',
  paneCloseRequest: 'orch:pane.closeRequest',
  missionsChanged: 'orch:missions.changed',
  handoffsChanged: 'orch:handoffs.changed',
  todosChanged: 'orch:todos.changed',
  squadsChanged: 'orch:squads.changed',
  /** Background MCP task lifecycle (started / exited / killed). */
  bgTaskEvent: 'orch:bgTask.event',
  /** Login-stuck watchdog: pane stuck on a CLI login screen (or recovered). */
  paneLoginStuck: 'orch:pane.loginStuck',
} as const;
