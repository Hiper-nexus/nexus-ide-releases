import { describe, expect, it } from 'vitest';
import {
  effectPolicyForTool,
  isHookMcpToolAllowedForReadOnlyContext,
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
    expect(effectPolicyForTool('nexus_mission_freeze_contract')).toBe(
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
      'nexus_validation_run',
      'nexus_merge_task',
    ]) {
      expect(effectPolicyForTool(tool)).toBe('workflow-authority');
      expect(requiresHumanConfirmationForTool(tool)).toBe(false);
    }
  });

  it('gives handoff submission its own handler-enforced authority', () => {
    expect(effectPolicyForTool('nexus_handoff_submit')).toBe('handoff-authority');
    expect(requiresHumanConfirmationForTool('nexus_handoff_submit')).toBe(false);
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

  it('limits read-only contexts to observations and narrow Nexus metadata receipts', () => {
    for (const tool of [
      'nexus_file_read',
      'nexus_git_diff',
      'nexus_pane_read',
      'nexus_context_draft_get',
      'nexus_context_draft_review',
      'nexus_handoff_submit',
      'nexus_handoff_ack',
      'nexus_worker_heartbeat',
    ]) {
      expect(isToolAllowedForReadOnlyContext(tool), tool).toBe(true);
    }

    for (const tool of [
      'nexus_file_write',
      'nexus_terminal_run',
      'nexus_git_add',
      'nexus_git_commit',
      'nexus_git_push',
      'nexus_pane_spawn',
      'nexus_route_task',
      'nexus_context_draft_apply',
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
    // Native CLI authority is enforced separately from the Nexus MCP boundary.
    expect(isHookMcpToolAllowedForReadOnlyContext('Bash')).toBe(true);
  });
});
