import {
  isDestructive,
  requiresConfirmation,
} from '../jarvis/guardrails';
import { canonicalToolName } from './gate';

export const RENDERER_EXACT_CONSENT_TOOLS: ReadonlySet<string> = new Set([
  'catalog_install',
  'agent_spec_write',
  'squad_save',
]);

const PER_ACTION_CONSENT_TOOLS: ReadonlySet<string> = new Set([
  'catalog_install',
  'agent_spec_write',
  'squad_save',
]);

export function requiresToolConfirmation(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return requiresConfirmation(toolName, args);
}

/** Destructive local shell effects always keep their per-action consent floor. */
export function isDestructiveEffect(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (canonical !== 'terminal_run' && canonical !== 'bg_run') return false;
  const command = typeof args.command === 'string' ? args.command : '';
  return command.length > 0 && isDestructive(command);
}

/** Persistent global instruction changes outlive mission-wide approval. */
export function requiresPerActionConsent(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (canonical === 'cron') return args.action !== 'list';
  return PER_ACTION_CONSENT_TOOLS.has(canonical);
}
