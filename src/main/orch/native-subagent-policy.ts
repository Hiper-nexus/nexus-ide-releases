import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isOperatorChoicePolicy, type SquadCliPolicyInput } from '../../shared/squad-cli-policy';
import { acceptsClaudeMcpCliFlags, usesClaudeHomeLayout } from './spawn-home-policy';

/**
 * Native helpers share this pane's account and execution authority. The
 * orchestrator never gets `Task`: it delegates through visible panes (routing,
 * quota and ledger stay in the Maestro's hands), and in free mode the gate hooks
 * that would otherwise deny a native `task` are not installed.
 */
export function nativeSubagentPolicyArgs(
  adapter: Pick<CliPtyAdapter, 'bin' | 'env' | 'quirks'>,
  authority: {
    readonly squadCliPolicy: SquadCliPolicyInput;
    readonly readOnly?: boolean;
    readonly nativeReadOnly?: boolean;
    readonly role?: string;
  },
): string[] {
  if (!acceptsClaudeMcpCliFlags(adapter)) return [];
  if (
    authority.role !== 'orchestrator' &&
    isOperatorChoicePolicy(authority.squadCliPolicy) &&
    authority.readOnly !== true &&
    authority.nativeReadOnly !== true
  ) {
    return [];
  }
  return [usesClaudeHomeLayout(adapter) ? '--disallowedTools' : '--disallowed-tools', 'Task'];
}

