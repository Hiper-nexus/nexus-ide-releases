import { describe, expect, it } from 'vitest';
import { buildToolset } from './tools';
import { effectPolicyForTool } from './mcp-effect-policy';
import { isPlanLaneWritablePath } from '../../shared/mission-intent';

describe('F2–F4 tool registration', () => {
  it('registers bg, plan, and hunks tools in the MCP toolset', () => {
    const names = new Set(buildToolset().map((t) => t.name));
    for (const name of [
      'nexus_bg_run',
      'nexus_bg_wait',
      'nexus_bg_kill',
      'nexus_bg_list',
      'nexus_plan_write',
      'nexus_plan_read',
      'nexus_hunks_analyze',
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('keeps code_map tools (F4 graph) in the toolset', () => {
    const names = new Set(buildToolset().map((t) => t.name));
    expect(names.has('nexus_code_map_get')).toBe(true);
    expect(names.has('nexus_code_map_query')).toBe(true);
    expect(names.has('nexus_code_map_blast_radius')).toBe(true);
  });

  it('plan-lane writable paths are restricted', () => {
    expect(isPlanLaneWritablePath('plan.md')).toBe(true);
    expect(isPlanLaneWritablePath('docs/plan.md')).toBe(true);
    expect(isPlanLaneWritablePath('src/main.ts')).toBe(false);
    expect(isPlanLaneWritablePath('../plan.md')).toBe(false);
  });

  it('bg_run is execution-effect; plan_read is read-only', () => {
    expect(effectPolicyForTool('nexus_bg_run')).toBe('execution-effect');
    expect(effectPolicyForTool('nexus_plan_read')).toBe('read-only');
  });
});
