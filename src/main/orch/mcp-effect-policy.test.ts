import { describe, expect, it } from 'vitest';
import {
  effectPolicyForTool,
  requiresHumanConfirmationForTool,
} from './mcp-effect-policy';

describe('MCP effect policy', () => {
  it('keeps observations available before a mission exists', () => {
    expect(effectPolicyForTool('nexus_context_doctor')).toBe('read-only');
    expect(effectPolicyForTool('file_read')).toBe('read-only');
  });

  it('allows only the context and mission bootstrap chain pre-contract', () => {
    expect(effectPolicyForTool('nexus_mission_create')).toBe('bootstrap-authority');
    expect(effectPolicyForTool('nexus_context_draft_review_run')).toBe(
      'bootstrap-authority',
    );
    expect(effectPolicyForTool('nexus_mission_freeze_contract')).toBe(
      'bootstrap-authority',
    );
  });

  it('requires execution-stage authority for direct code and command effects', () => {
    expect(effectPolicyForTool('nexus_file_write')).toBe('execution-effect');
    expect(effectPolicyForTool('terminal_run')).toBe('execution-effect');
  });

  it('keeps PREVC transitions under workflow authority without human prompts', () => {
    for (const tool of [
      'nexus_review_submit',
      'nexus_sensor_run',
      'nexus_workflow_advance',
      'nexus_validation_run',
      'nexus_merge_task',
      'nexus_mission_set_status',
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
    expect(requiresHumanConfirmationForTool('nexus_context_doctor')).toBe(false);
    expect(requiresHumanConfirmationForTool('nexus_context_commit')).toBe(false);
    expect(requiresHumanConfirmationForTool('nexus_file_write')).toBe(true);
    expect(requiresHumanConfirmationForTool('nexus_future_unknown_tool')).toBe(true);
  });

  it('does not prompt for bounded local controls but keeps them effectful', () => {
    expect(effectPolicyForTool('nexus_file_open')).toBe('mission-control');
    expect(requiresHumanConfirmationForTool('nexus_file_open')).toBe(false);
    expect(effectPolicyForTool('nexus_terminal_kill')).toBe('mission-control');
  });

  it('treats every unclassified or newly added tool as a mission effect', () => {
    expect(effectPolicyForTool('nexus_future_unknown_tool')).toBe('mission-effect');
  });
});
