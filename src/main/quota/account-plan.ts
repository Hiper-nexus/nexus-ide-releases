/**
 * Detecção do plano de assinatura por CONTA — o que o provider informa de
 * verdade, nunca estimativa:
 *
 *  - Claude: `oauthAccount.organizationRateLimitTier` no `.claude.json` da
 *    âncora da conta (diretório gerenciado, perfil de disco casado por
 *    e-mail, `~/.claude.json` nativo). O CLI reescreve esse bloco a cada
 *    `/usage`, então a leitura acompanha upgrade/downgrade.
 *  - Codex/ChatGPT: claim `chatgpt_plan_type` dentro do `id_token` JWT do
 *    `auth.json` (nativo ou blob vault) — decode local, sem request extra.
 *  - AGY/Gemini: `currentTier.id` do `loadCodeAssist` — um POST leve quando
 *    o probe de janelas não o viu.
 *
 * Preço (monthlyUsd) só entra para tiers de lista pública conhecida;
 * Team/Enterprise e tiers novos ficam com `monthlyUsd: null` — o resumo
 * conta a detecção mas não soma valor inventado.
 */

import os from 'node:os';
import path from 'node:path';
import type { AccountPlan } from '../../shared/quota-types';
import { getAccount } from '../persistence/account-store';
import {
  managedClaudeAuthDirectory,
  hasManagedClaudeAuth,
} from '../adapters/managed-claude-auth';
import { findClaudeProfileByEmail } from './claude-account-usage';
import { readClaudeConfigSnapshotAsync } from '../adapters/claude-config-snapshot';
import type { CodexChatGptAuth } from './codex-usage';
import type { GeminiOauthCreds } from './agy-usage';
import type { FetchLike } from './claude-oauth-usage';

/** Adapters para os quais tentamos detectar plano de assinatura. */
export const PLAN_CAPABLE_ADAPTERS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'agy',
]);

function plan(tier: string, label: string, monthlyUsd: number | null): AccountPlan {
  return { source: 'detected', tier, label, monthlyUsd };
}

// ---------------------------------------------------------------------------
// Claude — organizationRateLimitTier do oauthAccount
// ---------------------------------------------------------------------------

/**
 * `default_claude_max_20x` → 'Claude Max 20×' $200 · `default_claude_max_5x`
 * → $100 · `default_claude_pro` → $20 · team/enterprise → rótulo sem preço.
 */
export function planFromClaudeTier(
  tier: string | undefined,
  organizationType?: string,
): AccountPlan | null {
  const t = (tier ?? '').trim().toLowerCase();
  const org = (organizationType ?? '').trim().toLowerCase();
  if (!t) {
    if (org.includes('team')) return plan('team', 'Claude Team', null);
    if (org.includes('enterprise')) return plan('enterprise', 'Claude Enterprise', null);
    return null;
  }
  if (t.includes('max_20x')) return plan(t, 'Claude Max 20×', 200);
  if (t.includes('max_5x')) return plan(t, 'Claude Max 5×', 100);
  if (t.includes('max')) return plan(t, 'Claude Max', null);
  if (t.includes('pro')) return plan(t, 'Claude Pro', 20);
  if (t.includes('team')) return plan(t, 'Claude Team', null);
  if (t.includes('enterprise')) return plan(t, 'Claude Enterprise', null);
  if (t.includes('free')) return plan(t, 'Claude Free', 0);
  return plan(t, `Claude (${t})`, null);
}

/** `.claude.json` cru → plano, com guarda de e-mail quando a conta declara. */
export async function planFromClaudeAccountFile(
  accountFile: string,
  expectedEmail?: string,
): Promise<AccountPlan | null> {
  const snap = await readClaudeConfigSnapshotAsync(accountFile);
  if (!snap?.rateLimitTier && !snap?.organizationType) return null;
  const accountEmail = expectedEmail?.trim().toLowerCase();
  if (
    accountEmail &&
    snap.email &&
    snap.email.trim().toLowerCase() !== accountEmail
  ) {
    // oauthAccount de OUTRA conta dentro do arquivo: não herda o plano.
    return null;
  }
  return planFromClaudeTier(snap.rateLimitTier, snap.organizationType);
}

/**
 * Plano de UMA conta Claude vault — lê o `.claude.json` das mesmas âncoras
 * que a cascata de uso usa (nenhuma chamada de rede):
 *  1. diretório de auth gerenciada/materializada (`<dir>/.claude.json`);
 *  2. perfil de disco com o MESMO e-mail da conta;
 *  3. `~/.claude.json` nativo, só quando o e-mail casa.
 */
export async function claudeAccountPlan(
  accountId: string,
  opts: { home?: string } = {},
): Promise<AccountPlan | null> {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== 'claude') return null;
  const email = account.email?.trim().toLowerCase() || undefined;

  if (hasManagedClaudeAuth(accountId)) {
    const p = await planFromClaudeAccountFile(
      path.join(managedClaudeAuthDirectory(accountId, opts.home), '.claude.json'),
      email,
    );
    if (p) return p;
  }

  if (email) {
    const profile = await findClaudeProfileByEmail(email, opts.home);
    if (profile) {
      const p = await planFromClaudeAccountFile(profile.accountFile, email);
      if (p) return p;
    }
  }

  const home = opts.home ?? os.homedir();
  return planFromClaudeAccountFile(path.join(home, '.claude.json'), email);
}

/** Plano da linha nativa (`~/.claude.json`) — conta do login do CLI. */
export function claudeNativePlan(home = os.homedir()): Promise<AccountPlan | null> {
  return planFromClaudeAccountFile(path.join(home, '.claude.json'));
}

// ---------------------------------------------------------------------------
// Codex / ChatGPT — claim chatgpt_plan_type no id_token
// ---------------------------------------------------------------------------

/**
 * `pro` → 'ChatGPT Pro' $200 · `plus` → $20 · `go` → $5 · `free` → $0 ·
 * team/business/enterprise são por assento — rótulo sem preço.
 */
export function planFromCodexPlanType(
  planType: string | undefined,
): AccountPlan | null {
  const t = (planType ?? '').trim().toLowerCase();
  if (!t) return null;
  switch (t) {
    case 'pro':
      return plan(t, 'ChatGPT Pro', 200);
    case 'plus':
      return plan(t, 'ChatGPT Plus', 20);
    case 'go':
      return plan(t, 'ChatGPT Go', 5);
    case 'free':
      return plan(t, 'ChatGPT Free', 0);
    case 'team':
      return plan(t, 'ChatGPT Team', null);
    case 'business':
      return plan(t, 'ChatGPT Business', null);
    case 'enterprise':
      return plan(t, 'ChatGPT Enterprise', null);
    case 'edu':
      return plan(t, 'ChatGPT Edu', null);
    default:
      return plan(t, `ChatGPT (${t})`, null);
  }
}

// ---------------------------------------------------------------------------
// AGY / Gemini — currentTier do loadCodeAssist
// ---------------------------------------------------------------------------

const AGY_LOAD_CODE_ASSIST_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

/**
 * `free-tier` → $0. Pro de consumidor → $20 (lista $19,99). Ultra só ganha
 * preço quando o id diz o multiplicador publicado no I/O 2026: 5× = $100,
 * 20× = $200. Ultra sem esse número fica sem preço — existem os dois.
 */
export function planFromAgyTier(
  id: string | undefined,
  name?: string,
): AccountPlan | null {
  const t = (id ?? '').trim().toLowerCase();
  const named = (name ?? '').trim().toLowerCase();
  const blob = `${t} ${named}`;
  if (!t && !name) return null;
  if (t === 'free-tier' || t === 'free') return plan(t || 'free', 'Google AI Free', 0);
  if (blob.includes('ultra')) {
    const price = blob.includes('20x') || blob.includes('20×')
      ? 200
      : blob.includes('5x') || blob.includes('5×')
        ? 100
        : null;
    return plan(t || 'ultra', name || 'Google AI Ultra', price);
  }
  if (t.includes('pro') && !t.includes('enterprise')) {
    return plan(t, name || 'Google AI Pro', 20);
  }
  if (t.includes('enterprise')) return plan(t, name || 'Code Assist Enterprise', null);
  if (t.includes('standard')) return plan(t, name || 'Code Assist Standard', null);
  if (t) return plan(t, name || `Google (${t})`, null);
  return plan('unknown', name || 'Google AI', null);
}

/**
 * Plano AGY via `loadCodeAssist` — a mesma chamada que o probe de janelas já
 * faz. Best-effort: qualquer falha → null (plano simplesmente não detectado).
 */
export async function fetchAgyPlanTier(
  creds: GeminiOauthCreds,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<AccountPlan | null> {
  const accessToken = creds.accessToken?.trim();
  if (!accessToken) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5_000);
  try {
    const res = await fetchImpl(AGY_LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'antigravity',
      },
      body: JSON.stringify({
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      currentTier?: { id?: unknown; name?: unknown };
    };
    const tier = body?.currentTier;
    if (!tier || typeof tier !== 'object') return null;
    return planFromAgyTier(
      typeof tier.id === 'string' ? tier.id : undefined,
      typeof tier.name === 'string' ? tier.name : undefined,
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher usado pelo quota-service
// ---------------------------------------------------------------------------

export interface DetectPlanDeps {
  resolveCodexAuthCandidates?: (
    accountId?: string,
  ) => CodexChatGptAuth[] | Promise<CodexChatGptAuth[]>;
  resolveGeminiOauthCreds?: (
    accountId?: string,
  ) => GeminiOauthCreds | null | Promise<GeminiOauthCreds | null>;
  resolveGeminiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  fetchImpl?: FetchLike;
  /** Injetável em teste — leitura de plano Claude por conta vault. */
  claudePlan?: (accountId: string) => AccountPlan | null | Promise<AccountPlan | null>;
  claudeNative?: () => AccountPlan | null | Promise<AccountPlan | null>;
}

/**
 * Plano detectado da linha — null para adapters sem assinatura consultável
 * ou quando a fonte não responde. Nunca inventa tier nem preço.
 */
export async function detectProviderPlan(
  adapterId: string,
  accountId: string | undefined,
  deps: DetectPlanDeps,
): Promise<AccountPlan | null> {
  try {
    switch (adapterId) {
      case 'claude':
        // `await` dentro do try: uma leitura que rejeita vira null, não exceção.
        return await (accountId
          ? (deps.claudePlan ?? claudeAccountPlan)(accountId)
          : (deps.claudeNative ?? claudeNativePlan)());
      case 'codex': {
        const list = deps.resolveCodexAuthCandidates
          ? await Promise.resolve(deps.resolveCodexAuthCandidates(accountId))
          : [];
        for (const auth of list) {
          const p = planFromCodexPlanType(auth?.planType);
          if (p) return p;
        }
        return null;
      }
      case 'agy': {
        let creds: GeminiOauthCreds | null = null;
        if (deps.resolveGeminiOauthCreds) {
          creds = await Promise.resolve(deps.resolveGeminiOauthCreds(accountId));
        } else if (deps.resolveGeminiToken) {
          const access = await Promise.resolve(deps.resolveGeminiToken(accountId));
          if (access) creds = { accessToken: access };
        }
        return creds ? fetchAgyPlanTier(creds, { fetchImpl: deps.fetchImpl }) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
