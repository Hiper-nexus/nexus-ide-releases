/** Hard ceiling shared with the realtime action boundary. */
export const DELEGATION_PROMPT_MAX_CHARS = 4_000;

const EXECUTION_CONTRACT = `Execution requirements:
- Inspect the existing implementation and current project context before acting.
- Preserve the user's explicit constraints and the project's established architecture and conventions; do not invent product scope, providers, accounts, or destructive operations.
- Complete the requested outcome within the stated scope and handle relevant error and edge states.
- Run the relevant focused checks or tests and fix regressions caused by the work.

Acceptance criteria:
- The requested outcome works in the current workspace.
- Relevant checks pass, or any external blocker is reported with concrete evidence.
- The final response lists the changes, verification performed, and remaining blockers.`;

const OBJECTIVE_HEADING_RE = /(?:^|\n)\s*(?:objective|objetivo)\s*:/i;
const REQUIREMENTS_HEADING_RE =
  /(?:^|\n)\s*(?:execution requirements|requirements|requisitos de execu[cç][aã]o|requisitos)\s*:/i;
const ACCEPTANCE_HEADING_RE =
  /(?:^|\n)\s*(?:acceptance criteria|crit[eé]rios de aceita[cç][aã]o|aceite)\s*:/i;

export function isExecutionReadyDelegationPrompt(text: string): boolean {
  return (
    OBJECTIVE_HEADING_RE.test(text) &&
    REQUIREMENTS_HEADING_RE.test(text) &&
    ACCEPTANCE_HEADING_RE.test(text)
  );
}

/**
 * Gemini/OpenAI author the task-specific brief. This deterministic fallback
 * prevents a raw or underspecified transcript from being dumped into a squad.
 */
export function prepareDelegationPrompt(text: string): string {
  const trimmed = text.trim();
  if (isExecutionReadyDelegationPrompt(trimmed)) {
    return trimmed.slice(0, DELEGATION_PROMPT_MAX_CHARS);
  }

  const prefix = 'Objective: ';
  const separator = '\n\n';
  const available = Math.max(
    0,
    DELEGATION_PROMPT_MAX_CHARS - prefix.length - separator.length - EXECUTION_CONTRACT.length,
  );
  const clipped = trimmed.slice(0, available).trimEnd();
  return `${prefix}${clipped}${separator}${EXECUTION_CONTRACT}`;
}
