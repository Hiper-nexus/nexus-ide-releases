import {
  RENDERER_EXACT_CONSENT_TOOLS,
  requiresExactConsentReceipt,
  isDestructiveEffect,
  requiresPerActionConsent,
} from './mcp-consent-policy';
import { describe, expect, it } from 'vitest';
import {
  effectPolicyForTool,
  isHookMcpToolAllowedForReadOnlyContext,
  permitsOperatorPaneEffect,
  permitsOperatorVibeEffect,
  isToolAllowedForReadOnlyContext,
  requiresHumanConfirmationForTool,
} from './mcp-effect-policy';

describe('MCP effect policy', () => {
  it('keeps observations available before a mission exists', () => {
    expect(effectPolicyForTool('file_read')).toBe('read-only');
    expect(effectPolicyForTool('nexus_code_map_get')).toBe('read-only');
    expect(effectPolicyForTool('nexus_code_map_blast_radius')).toBe('read-only');
    expect(effectPolicyForTool('nexus_content_audit')).toBe('read-only');
    expect(effectPolicyForTool('nexus_security_audit')).toBe('read-only');
  });

  it('planejamento/comunicação não são gateados pelo freeze de contrato', () => {
    // Caso de campo 17/07: "nem documentar o Nexus deixava". Organizar tarefas
    // e perguntar ao usuário precede o freeze — não pode exigir contrato.
    expect(effectPolicyForTool('nexus_todo_manager')).toBe('read-only');
    expect(effectPolicyForTool('nexus_clarify')).toBe('read-only');
  });

  it('board de tarefas roda em piloto automático, sem confirmação humana', () => {
    // Caso de campo 18/07: cada nexus_task (até action:list) abria prompt
    // nativo; supervisor bloqueou a missão enquanto o clique não vinha.
    expect(effectPolicyForTool('nexus_task')).toBe('read-only');
    expect(requiresHumanConfirmationForTool('nexus_task')).toBe(false);
    expect(requiresHumanConfirmationForTool('task')).toBe(false);
  });

  it('allows only the context and mission bootstrap chain pre-contract', () => {
    expect(effectPolicyForTool('nexus_mission_create')).toBe('bootstrap-authority');
    expect(effectPolicyForTool('nexus_context_doctor')).toBe('bootstrap-authority');
    expect(effectPolicyForTool('nexus_context_draft_list')).toBe('read-only');
    expect(effectPolicyForTool('nexus_context_draft_review_run')).toBe(
      'bootstrap-authority',
    );
    expect(effectPolicyForTool('nexus_code_map_refresh')).toBe('bootstrap-authority');
    expect(effectPolicyForTool('nexus_mission_set_status')).toBe('bootstrap-authority');
  });

  it('keeps a narrow delegation route available before contract freeze', () => {
    for (const tool of [
      'nexus_agent_invoke',
      'nexus_pane_spawn',
      'nexus_mission_spawn_pane',
      'nexus_route_task',
    ]) {
      expect(effectPolicyForTool(tool)).toBe('delegation-authority');
      expect(requiresHumanConfirmationForTool(tool)).toBe(false);
    }
  });

  it('requires execution-stage authority for direct code and command effects', () => {
    expect(effectPolicyForTool('nexus_file_write')).toBe('execution-effect');
    expect(effectPolicyForTool('terminal_run')).toBe('execution-effect');
    expect(effectPolicyForTool('nexus_plan_write')).toBe('execution-effect');
    expect(effectPolicyForTool('nexus_bg_run')).toBe('execution-effect');
  });

  it('keeps public browser navigation mission-bound without treating research as code execution', () => {
    expect(effectPolicyForTool('nexus_browser_open')).toBe('mission-effect');
    expect(effectPolicyForTool('nexus_browser_navigate')).toBe('mission-effect');
    expect(requiresHumanConfirmationForTool('nexus_browser_open')).toBe(true);
    expect(requiresHumanConfirmationForTool('nexus_browser_navigate')).toBe(true);
    expect(effectPolicyForTool('nexus_browser_click')).toBe('execution-effect');
    expect(effectPolicyForTool('nexus_browser_fill')).toBe('execution-effect');
  });

  it('classifies plan/bg/hunk observation tools as read-only or mission-control', () => {
    expect(effectPolicyForTool('nexus_plan_read')).toBe('read-only');
    expect(effectPolicyForTool('nexus_bg_list')).toBe('read-only');
    expect(effectPolicyForTool('nexus_bg_wait')).toBe('read-only');
    expect(effectPolicyForTool('nexus_hunks_analyze')).toBe('read-only');
    expect(effectPolicyForTool('nexus_bg_kill')).toBe('mission-control');
  });

  it('keeps PREVC transitions under workflow authority without human prompts', () => {
    for (const tool of [
      'nexus_review_submit',
      'nexus_sensor_run',
      'nexus_workflow_advance',
      'nexus_workflow_prepare_execution',
      'nexus_validation_run',
      'nexus_merge_task',
    ]) {
      expect(effectPolicyForTool(tool)).toBe('workflow-authority');
      expect(requiresHumanConfirmationForTool(tool)).toBe(false);
    }
  });

  it('gives handoff submission its own handler-enforced authority', () => {
    expect(effectPolicyForTool('nexus_handoff_submit')).toBe('handoff-authority');
    expect(effectPolicyForTool('nexus_worker_heartbeat')).toBe(
      'handoff-authority',
    );
    expect(requiresHumanConfirmationForTool('nexus_handoff_submit')).toBe(false);
    expect(requiresHumanConfirmationForTool('nexus_worker_heartbeat')).toBe(
      false,
    );
  });

  it('allows only the Nexus UI action through renderer-owned authority', () => {
    expect(effectPolicyForTool('nexus_ui_action')).toBe(
      'renderer-authorized-effect',
    );
    expect(requiresHumanConfirmationForTool('nexus_ui_action')).toBe(true);
    expect(effectPolicyForTool('nexus_browser_click')).toBe('execution-effect');
  });

  it('derives confirmation from policy with a fail-closed unknown default', () => {
    expect(requiresHumanConfirmationForTool('nexus_code_map_get')).toBe(false);
    expect(requiresHumanConfirmationForTool('nexus_context_commit')).toBe(false);
    expect(requiresHumanConfirmationForTool('nexus_file_write')).toBe(true);
    expect(requiresHumanConfirmationForTool('nexus_future_unknown_tool')).toBe(true);
  });

  it('does not prompt for bounded local controls but keeps them effectful', () => {
    expect(effectPolicyForTool('nexus_file_open')).toBe('mission-control');
    expect(requiresHumanConfirmationForTool('nexus_file_open')).toBe(false);
    expect(effectPolicyForTool('nexus_terminal_kill')).toBe('mission-control');
  });

  it('permits only the narrow renderer-owned repository sync before a mission', () => {
    expect(effectPolicyForTool('nexus_git_sync')).toBe('routine-local-operation');
    expect(requiresHumanConfirmationForTool('nexus_git_sync')).toBe(false);
  });

  it('treats every unclassified or newly added tool as a mission effect', () => {
    expect(effectPolicyForTool('nexus_future_unknown_tool')).toBe('mission-effect');
  });

  it('classifies nexus_pick_account as read-only like quota_status', () => {
    expect(effectPolicyForTool('nexus_pick_account')).toBe('read-only');
    expect(effectPolicyForTool('pick_account')).toBe('read-only');
    expect(isToolAllowedForReadOnlyContext('nexus_pick_account')).toBe(true);
    expect(requiresHumanConfirmationForTool('nexus_pick_account')).toBe(false);
  });

  it('limits read-only contexts to observations and narrow Nexus metadata receipts', () => {
    for (const tool of [
      'nexus_file_read',
      'nexus_git_diff',
      'nexus_pr_inspect',
      'nexus_pane_read',
      'nexus_context_draft_get',
      'nexus_context_draft_review',
      'nexus_handoff_submit',
      'nexus_handoff_ack',
      'nexus_worker_heartbeat',
      // Merge/plan council submit: read-only reviewers must list and call these.
      'nexus_merge_review_submit',
      'nexus_review_submit',
      // F-769: shared long-term memory is retainable from a read-only pane.
      'nexus_memory_retain',
    ]) {
      expect(isToolAllowedForReadOnlyContext(tool), tool).toBe(true);
    }

    for (const tool of [
      'nexus_file_write',
      'nexus_git_add',
      'nexus_git_commit',
      'nexus_git_push',
      'nexus_pr_enqueue',
      'nexus_pr_auto_merge',
      'nexus_route_task',
      'nexus_context_draft_apply',
      'nexus_merge_task',
      'terminal_run',
      'terminal_input',
      'nexus_future_unknown_tool',
    ]) {
      expect(isToolAllowedForReadOnlyContext(tool), tool).toBe(false);
    }
  });

  it('applies the same read-only boundary to Claude Nexus MCP hook names', () => {
    expect(
      isHookMcpToolAllowedForReadOnlyContext(
        'mcp__nexus__nexus_context_draft_get',
      ),
    ).toBe(true);
    expect(
      isHookMcpToolAllowedForReadOnlyContext(
        'mcp__nexus__nexus_handoff_submit',
      ),
    ).toBe(true);
    expect(
      isHookMcpToolAllowedForReadOnlyContext(
        'mcp__nexus__nexus_file_write',
      ),
    ).toBe(false);
    expect(
      isHookMcpToolAllowedForReadOnlyContext(
        'mcp__nexus__nexus_terminal_run',
      ),
    ).toBe(false);
    expect(
      isHookMcpToolAllowedForReadOnlyContext(
        'mcp__nexus__nexus_terminal_input',
      ),
    ).toBe(false);
    // Native CLI authority is enforced separately from the Nexus MCP boundary.
    expect(isHookMcpToolAllowedForReadOnlyContext('Bash')).toBe(true);
  });
});

describe('zero fricção (0.27.0) — o que ainda pergunta, e por quê', () => {
  // O gate de aprovação saiu (2e24cee3) e a entrega roda no próprio checkout
  // (5c0208b9). Este bloco fixa o que SOBRA de consentimento por ação, para
  // ninguém remover por engano — nem reintroduzir fricção sem perceber.
  it('efeito destrutivo de shell mantém o piso de consentimento', () => {
    // rm -rf / push --force / reset --hard não têm como ser "reversíveis":
    // é o único caso em que perguntar é mais barato que desfazer.
    expect(isDestructiveEffect('nexus_terminal_run', { command: 'rm -rf /tmp/x' })).toBe(
      true,
    );
    expect(
      isDestructiveEffect('nexus_terminal_run', { command: 'git push --force' }),
    ).toBe(true);
    expect(
      isDestructiveEffect('nexus_terminal_run', { command: 'npm test' }),
    ).toBe(false);
  });

  it('os três "persistentes" nunca perguntaram: são NEGADOS antes do consentimento', () => {
    // Correção de premissa medida no código: catalog_install, agent_spec_write e
    // squad_save caem em RENDERER_EXACT_CONSENT_TOOLS e são recusados em
    // mcp-dispatch.ts ANTES do ramo de consentimento — exigem a superfície
    // nativa. Listá-los aqui prometia uma pergunta que o dispatch não faz.
    for (const tool of ['catalog_install', 'agent_spec_write', 'squad_save']) {
      expect(requiresPerActionConsent(tool, {})).toBe(false);
      expect(RENDERER_EXACT_CONSENT_TOOLS.has(tool)).toBe(true);
    }
  });

  it('cron muta sem modal, mas o RECIBO exato continua exigido', () => {
    // A separação que fez a remoção do prompt não quebrar o cron: o modal
    // pergunta quem autorizou; o recibo prova que a mutação foi autorizada uma
    // vez só — e cron-runtime.ts:354 recusa gravar sem ele. Amarrar os dois num
    // predicado só transformava "tirar a pergunta" em cron_exact_consent_required
    // em toda agenda.
    expect(requiresPerActionConsent('nexus_cron', { action: 'create' })).toBe(
      false,
    );
    expect(
      requiresExactConsentReceipt('nexus_cron', { action: 'create' }),
    ).toBe(true);
    // Ler agenda não muta nada: sem recibo e sem pergunta.
    expect(requiresExactConsentReceipt('nexus_cron', { action: 'list' })).toBe(
      false,
    );
  });

  it('trabalho ordinário de missão NÃO é consentimento por ação', () => {
    // O caminho quente: rodar teste, escrever arquivo, despachar tarefa.
    // Se algum destes virar true, a fricção voltou pela porta dos fundos.
    expect(requiresPerActionConsent('nexus_terminal_run', { command: 'npm test' })).toBe(
      false,
    );
    expect(requiresPerActionConsent('nexus_task', {})).toBe(false);
    expect(requiresPerActionConsent('nexus_handoff_submit', {})).toBe(false);
  });
  it('mão do operador sem missão pode spawn/write/ask/close de panes — e só isso', () => {
    // Campo 09/09: terminal aberto pela opção de pane, agente pede outros
    // panes e leva "mission effect blocked" em tudo. A sessão user já abre
    // pane pela UI; exigir missão para o mesmo gesto via MCP era cerimônia.
    const operator = { role: 'user' };
    for (const tool of ['nexus_pane_spawn', 'pane_write', 'nexus_pane_ask', 'pane_close']) {
      expect(permitsOperatorPaneEffect(operator, tool)).toBe(true);
    }
    // Estreito: nada de shell, arquivo, git ou handoff sem missão.
    for (const tool of ['nexus_terminal_run', 'file_write', 'git_push', 'nexus_handoff_submit', 'mission_set_status']) {
      expect(permitsOperatorPaneEffect(operator, tool)).toBe(false);
    }
    // Worker e orquestrador seguem presos à missão.
    expect(permitsOperatorPaneEffect({ role: 'worker' }, 'pane_spawn')).toBe(false);
    expect(permitsOperatorPaneEffect({ role: 'orchestrator' }, 'pane_spawn')).toBe(false);
    // Com missão a isenção não se aplica: o caminho normal decide.
    expect(permitsOperatorPaneEffect({ role: 'user', missionId: 'm1' }, 'pane_spawn')).toBe(false);
  });
  it('modo vibe: pane do operador sem missão destrava TODO efeito, não só panes', () => {
    // Decisão 09/09: "sem cabresto nenhum, só auditoria depois". O predicado é
    // por sessão (role user + sem missão), não por nome de tool — a fronteira
    // por tool continua existindo só como documentação da isenção antiga.
    expect(permitsOperatorVibeEffect({ role: 'user' })).toBe(true);
    // Papel e missão continuam sendo as fronteiras.
    expect(permitsOperatorVibeEffect({ role: 'worker' })).toBe(false);
    expect(permitsOperatorVibeEffect({ role: 'orchestrator' })).toBe(false);
    expect(permitsOperatorVibeEffect({ role: 'user', missionId: 'm1' })).toBe(false);
  });
});
