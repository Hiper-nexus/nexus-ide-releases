import { describe, expect, it } from 'vitest';
import claudeDefinition from '../../adapters/builtin/claude.json';
import openclaudeDefinition from '../../adapters/builtin/openclaude.json';
import { cliPtyAdapterSchema } from '../../shared/adapter-types';
import { nativeSubagentPolicyArgs } from './native-subagent-policy';

const claude = cliPtyAdapterSchema.parse(claudeDefinition);
const openclaude = cliPtyAdapterSchema.parse(openclaudeDefinition);

describe('native subagent spawn policy', () => {
  it.each([claude, openclaude])('does not statically remove Task from $id', (adapter) => {
    expect(adapter.spawn.extraArgs).not.toContain('Task');
  });

  it.each([undefined, 'operator-choice', 'unknown'])('keeps free native helpers available (%s)', (squadCliPolicy) => {
    expect(nativeSubagentPolicyArgs(claude, { squadCliPolicy })).toEqual([]);
    expect(nativeSubagentPolicyArgs(openclaude, { squadCliPolicy })).toEqual([]);
  });

  it('preserves the explicit governed policy with each native flag spelling', () => {
    expect(nativeSubagentPolicyArgs(claude, { squadCliPolicy: 'governed' }))
      .toEqual(['--disallowedTools', 'Task']);
    expect(nativeSubagentPolicyArgs(openclaude, { squadCliPolicy: 'governed' }))
      .toEqual(['--disallowed-tools', 'Task']);
  });

  it.each(['readOnly', 'nativeReadOnly'] as const)('keeps an explicit %s boundary in free mode', (boundary) => {
    expect(nativeSubagentPolicyArgs(claude, { squadCliPolicy: 'operator-choice', [boundary]: true }))
      .toEqual(['--disallowedTools', 'Task']);
  });

  it('never sends Claude flags to a different CLI binary', () => {
    expect(nativeSubagentPolicyArgs({ ...claude, bin: 'codex' }, { squadCliPolicy: 'governed' }))
      .toEqual([]);
  });
});
