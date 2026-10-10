import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isOperatorChoicePolicy, type SquadCliPolicyInput } from '../../shared/squad-cli-policy';
import { acceptsClaudeMcpCliFlags, usesClaudeHomeLayout } from './spawn-home-policy';

/**
 * Native helpers share this pane's account and execution authority.
 *
 * F-1157 (doutrina do dono): no modo padrão (Autopilot) todo agente —
 * orquestrador, helper, worker ou revisor — fica com o `Task` nativo; o
 * Nexus não corta subagentes. Só o modo Hardened, que o operador escolhe
 * explicitamente para confinar a squad, mantém o corte.
 */
export function nativeSubagentPolicyArgs(
  adapter: Pick<CliPtyAdapter, 'bin' | 'env' | 'quirks'>,
  authority: {
    readonly squadCliPolicy: SquadCliPolicyInput;
  },
): string[] {
  if (!acceptsClaudeMcpCliFlags(adapter)) return [];
  if (isOperatorChoicePolicy(authority.squadCliPolicy)) return [];
  return [usesClaudeHomeLayout(adapter) ? '--disallowedTools' : '--disallowed-tools', 'Task'];
}
