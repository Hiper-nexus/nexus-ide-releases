import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isOperatorChoicePolicy, type SquadCliPolicyInput } from '../../shared/squad-cli-policy';
import { acceptsClaudeMcpCliFlags, usesClaudeHomeLayout } from './spawn-home-policy';

/** Native helpers share this pane's account and execution authority. */
export function nativeSubagentPolicyArgs(
  adapter: Pick<CliPtyAdapter, 'bin' | 'env' | 'quirks'>,
  authority: {
    readonly squadCliPolicy: SquadCliPolicyInput;
    readonly readOnly?: boolean;
    readonly nativeReadOnly?: boolean;
  },
): string[] {
  if (!acceptsClaudeMcpCliFlags(adapter)) return [];
  if (
    isOperatorChoicePolicy(authority.squadCliPolicy) &&
    authority.readOnly !== true &&
    authority.nativeReadOnly !== true
  ) {
    return [];
  }
  return [usesClaudeHomeLayout(adapter) ? '--disallowedTools' : '--disallowed-tools', 'Task'];
}

