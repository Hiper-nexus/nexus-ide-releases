import { canonicalToolName } from './gate';

export type McpEffectPolicy =
  | 'read-only'
  | 'bootstrap-authority'
  | 'delegation-authority'
  | 'workflow-authority'
  | 'handoff-authority'
  | 'mission-control'
  | 'renderer-authorized-effect'
  | 'routine-local-operation'
  | 'mission-effect'
  | 'execution-effect';

const READ_ONLY_TOOLS = new Set([
  'load_workspace_dependencies',
  'agent_get',
  'agent_list',
  'browser_inspect',
  'browser_read',
  'browser_screenshot',
  'browser_wait',
  'context_draft_get',
  'context_draft_list',
  'code_map_get',
  'code_map_query',
  'code_map_blast_radius',
  'design_selection_get',
  'file_read',
  'file_search',
  'git_branch_list',
  'git_diff',
  'git_log',
  'git_status',
  'handoff_list',
  'media_providers',
  // Consulta de memória agentic (C2): leitura FTS local; o único write é o
  // contador de recall no banco de memória em userData (nunca no workspace).
  'memory_recall',
  'memory_stats',
  'merge_status',
  'mission_get',
  'mission_list',
  'pane_list',
  'pane_whoami',
  'pane_list_providers',
  'pane_read',
  'pane_read_many',
  'pane_wait_idle',
  'pane_wait_many',
  'perf_snapshot',
  'route_task',
  'sync_status',
  'system_doctor',
  'ui_read',
  'workflow_get',
  'worktree_get',
  'content_audit',
  'security_audit',
]);

/**
 * The only mutations allowed before a contract exists. Each tool below has
 * its own narrow authority checks and exists solely to establish the mission
 * and independently reviewed context that later effects must bind to.
 */
const BOOTSTRAP_AUTHORITY_TOOLS = new Set([
  'context_commit',
  'context_doctor',
  'context_draft_apply',
  'context_draft_propose',
  'context_draft_review',
  'context_draft_review_run',
  'context_scaffold',
  'code_map_refresh',
  'mission_create',
  'mission_freeze_contract',
  'mission_set_status',
  // Memória agentic (C2): mutação estreita e validada (≤8KB, redação de
  // segredos, dedupe) do banco de memórias em userData — não toca workspace
  // nem dados externos e precisa funcionar antes/fora de missão para TODAS
  // as CLIs hospedadas (panes livres inclusive).
  'memory_retain',
]);

/**
 * A coordinator must always retain one bounded path to a real worker. These
 * handlers bind the child to the same mission/squad and attenuate its tools;
 * they do not grant native write/shell authority to the coordinator itself.
 */
const DELEGATION_AUTHORITY_TOOLS = new Set([
  'agent_invoke',
  'mission_spawn_pane',
  'pane_spawn',
]);

/** PREVC state transitions whose handlers enforce mission/stage authority. */
const WORKFLOW_AUTHORITY_TOOLS = new Set([
  'merge_review_submit',
  'merge_retry',
  'merge_task',
  'plan_review_run',
  'review_submit',
  'sensor_run',
  'validation_run',
  'workflow_advance',
  'worktree_create',
]);

const HANDOFF_AUTHORITY_TOOLS = new Set(['handoff_submit', 'handoff_ack']);

/** Bounded local controls that do not change workspace or external data. */
const MISSION_CONTROL_TOOLS = new Set([
  'editor_focus',
  'editor_goto_line',
  'file_close',
  'file_open',
  'terminal_kill',
]);

/**
 * This effect is initiated by the authorized renderer and revalidates the
 * exact project-scoped WebContents in its main-process handler.
 */
const RENDERER_AUTHORIZED_EFFECT_TOOLS = new Set(['ui_action']);

/**
 * Local operations that may be initiated directly by the user-facing renderer
 * before a mission exists. Their handlers must enforce a narrow, reversible
 * operation themselves; this is deliberately not a general shell escape.
 */
const ROUTINE_LOCAL_OPERATION_TOOLS = new Set(['git_sync']);

/** Effects whose handlers may run only in PREVC's execution stage. */
const EXECUTION_EFFECT_TOOLS = new Set([
  'audio_generate',
  'browser_click',
  'browser_fill',
  'browser_navigate',
  'editor_apply_patch',
  'editor_insert',
  'editor_replace_selection',
  'file_write',
  'git_add',
  'git_branch_create',
  'git_branch_switch',
  'git_commit',
  'git_pull',
  'git_push',
  'image_generate',
  'terminal_run',
  'video_generate',
]);

/**
 * Default deny is intentional: a newly added tool is effectful until a human
 * reviewer explicitly proves it read-only or part of the bootstrap chain.
 */
export function effectPolicyForTool(toolName: string): McpEffectPolicy {
  const canonical = canonicalToolName(toolName);
  if (READ_ONLY_TOOLS.has(canonical)) return 'read-only';
  if (BOOTSTRAP_AUTHORITY_TOOLS.has(canonical)) return 'bootstrap-authority';
  if (DELEGATION_AUTHORITY_TOOLS.has(canonical)) return 'delegation-authority';
  if (WORKFLOW_AUTHORITY_TOOLS.has(canonical)) return 'workflow-authority';
  if (HANDOFF_AUTHORITY_TOOLS.has(canonical)) return 'handoff-authority';
  if (MISSION_CONTROL_TOOLS.has(canonical)) return 'mission-control';
  if (RENDERER_AUTHORIZED_EFFECT_TOOLS.has(canonical)) {
    return 'renderer-authorized-effect';
  }
  if (ROUTINE_LOCAL_OPERATION_TOOLS.has(canonical)) {
    return 'routine-local-operation';
  }
  if (EXECUTION_EFFECT_TOOLS.has(canonical)) return 'execution-effect';
  return 'mission-effect';
}

export function requiresHumanConfirmationForTool(toolName: string): boolean {
  const policy = effectPolicyForTool(toolName);
  return (
    policy === 'renderer-authorized-effect' ||
    policy === 'mission-effect' ||
    policy === 'execution-effect'
  );
}

export function isEffectfulTool(toolName: string): boolean {
  return effectPolicyForTool(toolName) !== 'read-only';
}
