import { z } from 'zod';

/**
 * Multi-account model with automatic failover (Orca-style hot-swap + Nexus
 * failover). An account belongs to an adapter and is either:
 *  - SUBSCRIPTION: Claude Keychain OAuth, or file-backed managed home for
 *    Codex/Grok/Kimi/OpenCode/AGY (auth.json snapshotted into the vault and
 *    materialized under ~/.nexus/managed-accounts on switch/spawn);
 *  - API-KEY: native provider key OR routed upstream (GLM/z.ai, DeepSeek…).
 *
 * Hot-swap rewrites the active credential pointer (no re-login). Running panes
 * keep their account until restart. Failover auto-switches on limit signatures.
 */

export type AccountMode = 'subscription' | 'api-key';

export interface Account {
  id: string;
  adapterId: string;
  label: string;
  mode: AccountMode;
  /** Routed upstream for api-key accounts (anthropic|glm|sakana|…). */
  upstream: string;
  /** Email for subscription accounts (from the Claude oauthAccount). */
  email?: string;
  /** Epoch ms until which this account is skipped after hitting a limit. */
  cooldownUntil?: number;
  /** Last failure reason shown in the UI. */
  lastError?: string;
  createdAt: number;
}

/** Secret-free account view for the renderer (never carries keys/blobs). */
export interface AccountInfo extends Account {
  active: boolean;
  hasCredential: boolean;
  onCooldown: boolean;
}

export const addAccountSchema = z.object({
  adapterId: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  mode: z.enum(['subscription', 'api-key']),
  upstream: z.string().max(32).default('anthropic'),
  /** For api-key mode: the key to store. For subscription: ignored (snapshot). */
  key: z.string().max(4096).optional(),
});
export type AddAccountRequest = z.infer<typeof addAccountSchema>;

export const accountIdSchema = z.object({ id: z.string().min(1).max(128) });
export const renameAccountSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
});

/** Main → renderer: a pane's account hit a limit; re-spawn it with --resume. */
export interface FailoverEvent {
  paneId: string;
  fromAccountLabel: string;
  toAccountLabel: string;
  reason: string;
  /** Whether a replacement account was found; false = no account left. */
  switched: boolean;
  /** Replacement account pinned to the pane before its resume spawn. */
  toAccountId?: string;
}

/** Main → renderer: user activated an account; panes may need restart. */
export interface AccountActivatedEvent {
  accountId: string;
  adapterId: string;
  label: string;
  /** Running CLI panes keep the old credential until respawned. */
  needsRestart: boolean;
}

/** Per-account quota/cooldown view for status-bar usage chip (P4). */
export interface AccountQuotaInfo {
  accountId: string;
  adapterId: string;
  label: string;
  active: boolean;
  onCooldown: boolean;
  cooldownUntil?: number;
  lastError?: string;
  email?: string;
  mode: AccountMode;
  hasCredential: boolean;
  /** Human status for the chip: ready | cooldown | no-credential. */
  status: 'ready' | 'cooldown' | 'no-credential' | 'inactive';
}

export const ACCOUNT_CHANNELS = {
  list: 'account:list',
  add: 'account:add',
  addActiveClaude: 'account:addActiveClaude',
  addActiveSession: 'account:addActiveSession',
  rename: 'account:rename',
  remove: 'account:remove',
  activate: 'account:activate',
  supportsSnapshot: 'account:supportsSnapshot',
  quota: 'account:quota',
  changed: 'account:changed',
  activated: 'account:activated',
  failover: 'account:failover',
} as const;

export const addActiveSessionSchema = z.object({
  adapterId: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
});
export type AddActiveSessionRequest = z.infer<typeof addActiveSessionSchema>;
