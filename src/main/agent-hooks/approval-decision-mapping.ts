// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: em vez do
// `PermissionResult` do SDK do Claude e das respostas do app-server do Codex,
// produz a SAÍDA do hook PermissionRequest das CLIs em PTY; "na sessão" do
// Claude só com regra `addRules` (as sugestões `setMode`/`addDirectories` e a
// regra ampla de shell ficam de fora); Codex 0.161 só aceita allow/deny pelo
// hook (`updatedPermissions`/`interrupt` recusam a resposta), então
// `acceptForSession` degrada para allow; ACP preferindo `allow_once`.
//
// Origens: permissionResultFromDecision / toSessionPermissionUpdates
// (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2242-2296),
// approvalDecisionToLegacyReviewDecision (CodexAdapterV2.ts:561-576),
// selectPermissionOptionId / selectAutoApprovedPermissionOption
// (AcpAdapterV2.ts:1081-1105).

import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalProvider,
} from '../../shared/approval-decision';

type HookDecision =
  | { behavior: 'allow'; updatedPermissions?: ClaudeSessionRule[] }
  | { behavior: 'deny'; message: string; interrupt?: true };

export type PermissionHookOutput = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: HookDecision };
};

export type ClaudeSessionRule = {
  type: 'addRules';
  rules: Array<{ toolName: string; ruleContent?: string }>;
  behavior: 'allow';
  destination: 'session';
};

const DECLINE_MESSAGE = 'User declined tool execution.';
const CANCEL_MESSAGE = 'User cancelled tool execution.';
/** Shell sem regra com prefixo: "na sessão" liberaria QUALQUER comando. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const MAX_SUGGESTIONS = 8;
const MAX_RULES = 8;
const MAX_TOOL_NAME = 128;
const MAX_RULE_CONTENT = 512;

function output(decision: HookDecision): PermissionHookOutput {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function sanitizeAddRules(suggestion: unknown): ClaudeSessionRule | null {
  if (!suggestion || typeof suggestion !== 'object') return null;
  const record = suggestion as Record<string, unknown>;
  if (record.type !== 'addRules' || record.behavior !== 'allow') return null;
  if (!Array.isArray(record.rules) || record.rules.length === 0 || record.rules.length > MAX_RULES) {
    return null;
  }
  const rules: ClaudeSessionRule['rules'] = [];
  for (const raw of record.rules) {
    if (!raw || typeof raw !== 'object') return null;
    const { toolName, ruleContent } = raw as { toolName?: unknown; ruleContent?: unknown };
    if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > MAX_TOOL_NAME) {
      return null;
    }
    if (ruleContent === undefined) {
      rules.push({ toolName });
      continue;
    }
    if (typeof ruleContent !== 'string' || ruleContent.length === 0 || ruleContent.length > MAX_RULE_CONTENT) {
      return null;
    }
    rules.push({ toolName, ruleContent });
  }
  // Reconstruído campo a campo: a sugestão vem do payload do hook e só a forma
  // conhecida volta para a CLI, sempre com destino `session`.
  return { type: 'addRules', rules, behavior: 'allow', destination: 'session' };
}

/**
 * Porte estreitado de `toSessionPermissionUpdates`. O T3 repassa todas as
 * sugestões com `destination: 'session'` e, sem sugestão, cria
 * `addRules [{toolName}]`. Aqui:
 * - só `addRules` passa (a sonda real com `touch` trouxe `addDirectories` +
 *   `setMode: acceptEdits`, que ampliariam a sessão além do pedido);
 * - shell sem `addRules` sugerido devolve null (não há escopo seguro) e a
 *   opção "na sessão" degrada para "só este pedido".
 */
export function claudeSessionPermissionUpdates(
  toolName: string,
  suggestions: unknown,
): ClaudeSessionRule[] | null {
  const list = Array.isArray(suggestions) ? suggestions.slice(0, MAX_SUGGESTIONS) : [];
  const rules = list.map(sanitizeAddRules).filter((rule): rule is ClaudeSessionRule => rule !== null);
  if (rules.length > 0) return rules;
  if (SHELL_TOOLS.has(toolName)) return null;
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
}

/** Saída do hook PermissionRequest do Claude Code para a decisão. */
export function claudePermissionHookOutput(
  decision: ApprovalDecision,
  request: { toolName: string; permissionSuggestions?: unknown },
): PermissionHookOutput {
  switch (decision) {
    case 'accept':
      return output({ behavior: 'allow' });
    case 'acceptForSession': {
      const updates = claudeSessionPermissionUpdates(request.toolName, request.permissionSuggestions);
      return output(updates ? { behavior: 'allow', updatedPermissions: updates } : { behavior: 'allow' });
    }
    case 'decline':
      return output({ behavior: 'deny', message: DECLINE_MESSAGE });
    case 'cancel':
      return output({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
  }
}

/**
 * Saída do hook PermissionRequest do Codex 0.161: só `allow` ou `deny` +
 * `message` (o schema embutido recusa a resposta com `updatedPermissions`,
 * `updatedInput` ou `interrupt`). "Na sessão" e "cancelar" degradam.
 */
export function codexPermissionHookOutput(decision: ApprovalDecision): PermissionHookOutput {
  return decision === 'accept' || decision === 'acceptForSession'
    ? output({ behavior: 'allow' })
    : output({ behavior: 'deny', message: decision === 'cancel' ? CANCEL_MESSAGE : DECLINE_MESSAGE });
}

export function permissionHookOutput(
  provider: ApprovalProvider,
  decision: ApprovalDecision,
  request: { toolName: string; permissionSuggestions?: unknown },
): PermissionHookOutput {
  return provider === 'codex'
    ? codexPermissionHookOutput(decision)
    : claudePermissionHookOutput(decision, request);
}

/** Opções do card: "na sessão" avisa quando o host vai responder só este pedido. */
export function approvalOptionsFor(
  provider: ApprovalProvider,
  request: { toolName: string; permissionSuggestions?: unknown },
): ApprovalOption[] {
  const sessionScoped =
    provider === 'claude' &&
    claudeSessionPermissionUpdates(request.toolName, request.permissionSuggestions) !== null;
  return [
    { optionId: 'accept' },
    sessionScoped ? { optionId: 'acceptForSession' } : { optionId: 'acceptForSession', degradesTo: 'accept' },
    { optionId: 'decline' },
  ];
}

export type AcpPermissionOption = {
  readonly optionId: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
};

/**
 * ACP (`session/request_permission`): escolhe a opção nativa da decisão. Porte
 * de `selectPermissionOptionId`; `cancel` não é uma opção (é o outcome
 * `cancelled`), então devolve undefined.
 */
export function acpPermissionOptionId(
  decision: ApprovalDecision,
  options: readonly AcpPermissionOption[],
): string | undefined {
  if (decision === 'cancel') return undefined;
  const kind =
    decision === 'acceptForSession' ? 'allow_always' : decision === 'accept' ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

/**
 * Aprovação automática pelo runtime: prefere `allow_once`, porque o
 * `allow_always` do Grok vale para o projeto inteiro (porte de
 * `selectAutoApprovedPermissionOption`).
 */
export function acpAutoApprovedOptionId(options: readonly AcpPermissionOption[]): string | undefined {
  return acpPermissionOptionId('accept', options) ?? acpPermissionOptionId('acceptForSession', options);
}
