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
  'lsp_definition',
  'lsp_diagnostics',
  'lsp_references',
  'lsp_symbols',
  'agent_get',
  'agent_list',
  'browser_inspect',
  'browser_read',
  // Sem mutação, mas com egress de pixels mascarados: o dispatch guard não o julga,
  // então a cerca vive no Main (captureRedactedBrowserVisual recusa perfil pessoal).
  'browser_judge_visual',
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
  // ORC-03: lista/prévia dos checkpoints ocultos. Não toca workspace, HEAD,
  // branch nem índice real; só grava objetos Git (prévia) e apaga ref de 0
  // byte do próprio namespace. A restauração (checkpoint_restore) é
  // execution-effect: confirmação, estágio de execução e nunca em read-only.
  'checkpoint_list',
  // Julgamento tipado (TypeSafe Jev): sem mutação de workspace nem efeito
  // externo; o único egress é para a conta TypeSafe configurada pelo usuário,
  // rate-limited por sessão.
  'judge',
  // Ranking de candidatos: idem — leitura tipada, composto calculado em código.
  'rank',
  // Recomendação de ferramenta: lê só a lista visível do próprio chamador.
  'tool_pick',
  'pr_inspect',
  'handoff_list',
  'media_providers',
  // Consulta de memória agentic (C2): leitura FTS local; o único write é o
  // contador de recall no banco de memória em userData (nunca no workspace).
  'memory_recall',
  'memory_stats',
  'memory_backlinks',
  'memory_orphans',
  'memory_suggest_connections',
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
  // Semantic agent wait (Herdr port): blocks on semantic status transitions
  // only; never writes pane input or workspace data.
  'agent_wait',
  'perf_snapshot',
  'sync_status',
  'system_doctor',
  'ui_read',
  'workflow_get',
  'worktree_get',
  'content_audit',
  'security_audit',
  // Planejamento/comunicação — NÃO são efeitos de código/contexto e não podem
  // ser reféns do freeze de contrato (caso de campo 17/07: "nem documentar o
  // Nexus deixava"). clarify grava somente um envelope de diálogo durável,
  // mission-scoped e reversível (nenhuma escrita no workspace);
  // todo_manager escreve apenas na lista de tarefas local, mission-scoped e
  // reversível (mesma natureza do contador de recall do memory_recall). Um
  // agente PRECISA organizar/perguntar ANTES de congelar contexto — gatear
  // isso atrás do freeze cria um deadlock de cerimônia.
  'clarify',
  'todo_manager',
  // task (nexus_task) gerencia o board de tarefas da missão: escreve apenas
  // linhas mission-scoped e reversíveis no runtime store — nunca workspace,
  // git ou dados externos. O enforcement real fica a jusante (worktree/spawn/
  // merge com authority própria; file/terminal/git com confirmação). Exigir
  // clique humano em cada list/plan quebrava o piloto automático (caso de
  // campo 18/07: supervisor bloqueou a missão por "sem tasks/workers"
  // enquanto o prompt nativo aguardava o operador).
  'task',
  // Plan / bg / hunks — observation or bounded local state (handlers enforce).
  'plan_read',
  'bg_list',
  'bg_wait',
  'hunks_analyze',
  // Instrument panel (tools-instruments.ts): five gauges an orchestrator reads
  // BEFORE deciding. Each handler is a pure projection of state another part of
  // the product already computed — no install, no auth, no selection, no
  // network probe, no write of any kind (not even a counter). Reviewed for the
  // read-only boundary field by field: account labels/e-mails, MCP env/header
  // values and argv, CLI binary paths and key previews are never shaped into a
  // response. Gating them behind confirmation would make consulting the fuel
  // gauge cost a human click on every routing decision.
  'quota_status',
  // Mesma família do quota_status: projeção do snapshot, sem write, sem
  // contato com provider. A decisão é aritmética (scorer), nunca Jev.
  'pick_account',
  'model_ranking',
  'mcp_servers',
  'skills_inventory',
  // Descobre e relata plugins; instalar é outra superfície (catalog_install,
  // que exige consentimento exato na UI nativa).
  'plugin_inventory',
  'cli_inventory',
  // Presença de credencial no cofre com máscara — sem valor, sem label.
  'vault_list',
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
  'mission_set_status',
  // Memória agentic (C2): mutação estreita e validada (≤8KB, redação de
  // segredos, dedupe) do banco de memórias em userData — não toca dados
  // externos e precisa funcionar antes/fora de missão para TODAS as CLIs
  // hospedadas (panes livres inclusive). A cópia legível no workspace só
  // existe com o opt-in do operador (F-806), fora deste caminho.
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
  // route_task now mints a durable one-shot RouteReservation consumed by
  // pane_spawn. It is delegation authority, not an observation.
  'route_task',
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
  'workflow_prepare_execution',
  'worktree_create',
]);

const HANDOFF_AUTHORITY_TOOLS = new Set([
  'handoff_submit',
  'handoff_ack',
  'worker_heartbeat',
]);

/**
 * Narrow Nexus metadata receipts that a read-only worker must still be able
 * to persist. These handlers revalidate mission/reviewer/session authority
 * and never grant workspace, process, delegation, or external side effects.
 *
 * Keep this list name-based rather than allowing an entire effect-policy
 * class: a newly classified authority tool must remain denied until its
 * handler is reviewed specifically for the read-only boundary.
 */
const READ_ONLY_CONTEXT_METADATA_TOOLS = new Set([
  'context_draft_review',
  'handoff_submit',
  'handoff_ack',
  'worker_heartbeat',
  // Merge council reviewers are spawned readOnly=true. The submit handler
  // revalidates the opaque review session + PTY + checkout and never writes
  // the workspace. Without this exact name, tools/list hides the endpoint and
  // the council burns the full timeout after a clean inspection (gate 0.19.32:
  // "nexus_merge_review_submit endpoint is not exposed").
  'merge_review_submit',
  'review_submit',
  // F-769: um pane read-only (revisor, juiz) também consulta e grava a memória
  // compartilhada. O retain é validado/redigido no handler e escreve só no
  // banco de memória em userData — nunca no workspace nem fora dele: o vault
  // opt-in da pasta do projeto nunca é disparado por contexto read-only, e a
  // nota nasce em quarentena (fora de todo brief até promoção) — F-806/F-808.
  'memory_retain',
]);

/**
 * Basic tools that must remain reachable even from a read-only gate context.
 * A read-only reviewer/orchestrator still needs to spawn panes, read files
 * and diagnose the workspace. The handlers enforce containment.
 *
 * Shell execution (terminal_run / terminal_input) is deliberately excluded:
 * there is no reliable mechanical way to classify an arbitrary shell command
 * as read-only, so read-only tokens must not reach the terminal at all.
 */
const READ_ONLY_BASIC_TOOLS = new Set([
  'pane_spawn',
  'file_read',
  'context_doctor',
  'pane_ask',
]);

/** Bounded local controls that do not change workspace or external data. */
const MISSION_CONTROL_TOOLS = new Set([
  'editor_focus',
  'editor_goto_line',
  'file_close',
  'file_open',
  'terminal_kill',
  'bg_kill',
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

/**
 * Efeitos que a MÃO DO OPERADOR pode disparar sem missão.
 *
 * Campo 09/09: o operador abriu um terminal pela opção de pane, pediu ao
 * agente para abrir outros panes e mandar mensagens, e levou
 * "mission effect blocked" em TODOS os efeitos — spawn, write, ask. A sessão
 * `user` só existe em pane aberto diretamente pelo operador (renderer
 * autorizado); ela já pode abrir qualquer pane pela UI, então exigir missão
 * para fazer o MESMO via MCP era cerimônia sem dano nomeado.
 *
 * Estreito de propósito: só pane-scoped, só `role: user`, só sem missão.
 * Worker e orquestrador seguem presos à missão; `terminal_run`, `file_write`,
 * git e afins continuam bloqueados sem missão como sempre.
 */
const OPERATOR_PANE_EFFECT_TOOLS = new Set([
  'pane_spawn',
  'pane_write',
  'pane_write_many',
  'pane_ask',
  'pane_close',
]);

export function permitsOperatorPaneEffect(
  ctx: { readonly role: string; readonly missionId?: string },
  toolName: string,
): boolean {
  return (
    ctx.role === 'user' &&
    !ctx.missionId &&
    OPERATOR_PANE_EFFECT_TOOLS.has(canonicalToolName(toolName))
  );
}

/**
 * Modo vibe (hardcoded, decisão 09/09): a mão do operador num pane sem missão
 * NÃO tem cabresto de efeito.
 *
 * O operador já digita `npm test`, `git commit` e `rm -rf` no próprio terminal;
 * exigir missão para o MESMO gesto via MCP transformava "abre o pane e manda
 * ver" em cerimônia de contexto/intenção. A partir daqui `file_write`,
 * `terminal_run`, `git_*`, `pr_*` e o que mais for rodam sem missão e sem
 * modal — inclusive destrutivo e externo (push/deploy), por escolha explícita
 * do operador ("sem cabresto nenhum, só auditoria depois").
 *
 * Fronteiras que PERMANECEM: pane-authz de alvo (worker não lê shell/browser),
 * allowlists do token, `RENDERER_EXACT_CONSENT_TOOLS` (mutação global de
 * agentes/squads continua na superfície nativa), o recibo exato do `cron` e o
 * bind de contexto da missão quando existe. O registro continua em auditoria;
 * texto destrutivo injetado em pane leva um aviso `[vibe]` no log.
 */
export function permitsOperatorVibeEffect(ctx: {
  readonly role: string;
  readonly missionId?: string;
}): boolean {
  return ctx.role === 'user' && !ctx.missionId;
}

/** Effects whose handlers may run only in PREVC's execution stage. */
const EXECUTION_EFFECT_TOOLS = new Set([
  'audio_generate',
  'browser_click',
  // browser_do executa as mesmas primitivas de escrita que click/fill —
  // uma confirmação por objetivo, mesma classe de efeito.
  'browser_do',
  'browser_fill',
  // computer_do executa as mesmas primitivas de escrita (System Events) —
  // uma confirmação por objetivo, mesma classe de efeito.
  'computer_do',
  'editor_apply_patch',
  'editor_insert',
  'editor_replace_selection',
  'pane_ask',
  // agent_prompt (Herdr port) writes prompt text into a pane PTY — same
  // effect class as pane_ask.
  'agent_prompt',
  'file_write',
  'plan_write',
  'git_add',
  // ORC-03: escreve arquivos calculados pelo Git na worktree do writer; os
  // destinos passam pela guarda de workflow no handler (tools-checkpoint).
  'checkpoint_restore',
  'git_branch_create',
  'git_branch_switch',
  'git_commit',
  'git_pull',
  'git_push',
  'pr_create',
  'pr_enqueue',
  'pr_auto_merge',
  'image_generate',
  'terminal_run',
  'bg_run',
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

/**
 * Mechanical MCP boundary for a token minted with readOnly=true.
 *
 * The effect policy remains default-deny, while a tiny set of internal Nexus
 * receipts is allowed by exact name. Allowlist/role/mission checks still run
 * independently; this predicate only answers whether read-only authority may
 * reach those later checks.
 */
export function isToolAllowedForReadOnlyContext(toolName: string): boolean {
  const canonical = canonicalToolName(toolName);
  return (
    effectPolicyForTool(canonical) === 'read-only' ||
    READ_ONLY_CONTEXT_METADATA_TOOLS.has(canonical) ||
    READ_ONLY_BASIC_TOOLS.has(canonical)
  );
}

/**
 * Claude-family PreToolUse receives Nexus MCP calls under an
 * `mcp__nexus__...` name. Apply the same policy there, while leaving native
 * CLI tools and other MCP servers to their own permission/sandbox boundary.
 */
export function isHookMcpToolAllowedForReadOnlyContext(
  hookToolName: string,
): boolean {
  const normalized = hookToolName.trim().toLowerCase();
  const nexusMcpPrefix = 'mcp__nexus__';
  if (normalized.startsWith(nexusMcpPrefix)) {
    return isToolAllowedForReadOnlyContext(
      normalized.slice(nexusMcpPrefix.length),
    );
  }
  if (normalized.startsWith('nexus_')) {
    return isToolAllowedForReadOnlyContext(normalized);
  }
  return true;
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
