import { z } from 'zod';

/**
 * Multi-account model with automatic failover. An account belongs to an
 * adapter (usually `claude`) and is either:
 *  - a SUBSCRIPTION account (Claude Max/OAuth): its credential is the Claude
 *    Code keychain blob, snapshotted into our vault and restored on switch;
 *  - an API-KEY account: a key for the native provider OR for a routed upstream
 *    (GLM/z.ai, Sakana Fugu, DeepSeek…) — GLM runs THROUGH the Claude CLI via
 *    ANTHROPIC_BASE_URL, so a GLM account is just a `claude` account with
 *    upstream='glm' and a z.ai key.
 *
 * When one account hits its limit (rate-limit/quota), the failover engine puts
 * it on cooldown, switches to the next available account for that adapter, and
 * re-spawns the pane's CLI with --resume to continue the conversation.
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
}

export const ACCOUNT_CHANNELS = {
  list: 'account:list',
  add: 'account:add',
  addActiveClaude: 'account:addActiveClaude',
  rename: 'account:rename',
  remove: 'account:remove',
  activate: 'account:activate',
  changed: 'account:changed',
  failover: 'account:failover',
} as const;
