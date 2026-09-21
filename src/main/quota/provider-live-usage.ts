/**
 * Dispatch live usage probes per adapter. Each probe is best-effort and
 * returns null when credentials or network fail — never invents usedRatio.
 *
 * Tries multiple credential candidates (vault / launcher / system CLI) so a
 * single stale key cannot hide real telemetry.
 */

import type { QuotaReadHint, QuotaWindow } from '../../shared/quota-types';
import {
  probeClaudeOauthUsage,
  type ClaudeCliUsageFailure,
  type FetchLike,
} from './claude-oauth-usage';
import {
  fetchCodexUsageWindows,
  type CodexChatGptAuth,
} from './codex-usage';
import { fetchGrokUsageWindows } from './grok-usage';
import {
  fetchDevinUsageWindows,
  resolveDevinApiKey,
} from './devin-usage';
import { fetchCursorUsageWindowsLive } from './cursor-usage';
import { fetchAgyUsageWindows, type GeminiOauthCreds } from './agy-usage';
import { fetchAgyBridgeUsage } from './agy-bridge';
import {
  fetchKimiCodingUsageWindows,
  fetchKimiUsageWithOauth,
  type KimiOauthCreds,
} from './kimi-usage';
import {
  fetchWindowsForApiKey,
  mergeWorstWindows,
} from './key-shape-usage';
import { loadOpenCodeAuthKeys } from './opencode-auth';
import { knownWindow } from './quota-normalize';

export interface ApiQuotaKeyRequest {
  adapterId: string;
  accountId?: string;
  usageProviderId: string;
  authMode: string;
}

export interface LiveUsageAuthResolvers {
  /** Main-owned exact credential selection; never a flattened multi-provider list. */
  resolveApiQuotaKey?: (request: ApiQuotaKeyRequest) => string | null | Promise<string | null>;
  resolveClaudeToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  /**
   * Fallback print-only `claude /usage` (injetável nos testes). Só corre na
   * row do CLI nativo (accountId indefinido) — o login do CLI é de UMA conta;
   * pintá-la em rows de contas vault seria fabricar dado por conta.
   * Devolve o probe completo: o motivo (`auth-expired` etc.) vira `readHint`
   * acionável na linha.
   */
  claudeCliUsage?: () => Promise<{
    windows: QuotaWindow[] | null;
    failure?: ClaudeCliUsageFailure;
  }>;
  /**
   * Evidência de login nativo Claude prévio (`oauthAccount` no
   * `~/.claude.json`). Sem token + sem evidência = nunca conectou
   * (`no-credential`); sem token + com evidência = sessão morta
   * (`auth-expired` → «Entrar novamente»).
   */
  claudeNativeSession?: () => boolean;
  /**
   * Access token nativo vencido (`expiresAt` cliente). A linhagem nativa
   * é do CLI — não refreshamos; token vencido equivale a sessão expirada.
   */
  claudeNativeTokenExpired?: () => boolean;
  /**
   * Fallback por conta Claude (Codenotch): auth gerenciada scoped, perfil de
   * disco com o mesmo e-mail, materialização do vault. Cada fonte é ancorada
   * na identidade da própria conta — só para rows pinadas (accountId set).
   */
  claudeAccountUsage?: (
    accountId: string,
  ) => Promise<{ windows: QuotaWindow[] | null; hint?: QuotaReadHint }>;
  /** Prefer multi-candidate; single still supported. */
  resolveCodexAuth?: (
    accountId?: string,
  ) => CodexChatGptAuth | null | Promise<CodexChatGptAuth | null>;
  resolveCodexAuthCandidates?: (
    accountId?: string,
  ) => CodexChatGptAuth[] | Promise<CodexChatGptAuth[]>;
  resolveGlmApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGlmApiKeyCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveGrokToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGrokTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  /** Sessão do Devin CLI (credentials.toml); default lê o ficheiro. */
  resolveDevinApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveKimiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveKimiTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  /** Full Kimi OAuth (access + refresh) — CLI path with auto-refresh. */
  resolveKimiOauthCreds?: (
    accountId?: string,
  ) => KimiOauthCreds | null | Promise<KimiOauthCreds | null>;
  resolveGeminiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  /** Full Gemini/AGY OAuth (access + refresh) for live quota. */
  resolveGeminiOauthCreds?: (
    accountId?: string,
  ) => GeminiOauthCreds | null | Promise<GeminiOauthCreds | null>;
  resolveLongcatApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveLongcatApiKeyCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  /** Generic vault/launcher/env keys for any adapter (opencode, aider, …). */
  resolveGenericApiKeyCandidates?: (
    adapterId: string,
    accountId?: string,
  ) => string[] | Promise<string[]>;
  fetchImpl?: FetchLike;
}

async function stringCandidates(
  multi:
    | ((accountId?: string) => string[] | Promise<string[]>)
    | undefined,
  single:
    | ((accountId?: string) => string | null | Promise<string | null>)
    | undefined,
  accountId?: string,
): Promise<string[]> {
  if (multi) {
    const list = await Promise.resolve(multi(accountId));
    return (list ?? []).filter((x) => typeof x === 'string' && x.trim());
  }
  if (single) {
    const one = await Promise.resolve(single(accountId));
    return one?.trim() ? [one.trim()] : [];
  }
  return [];
}

/** Resultado da sonda ao vivo: janelas ou o motivo honesto da ausência. */
export interface LiveProviderProbe {
  windows: QuotaWindow[] | null;
  hint?: QuotaReadHint;
}

const NO_CREDENTIAL: LiveProviderProbe = { windows: null, hint: 'no-credential' };
const UNAVAILABLE: LiveProviderProbe = { windows: null, hint: 'unavailable' };

function asProbe(windows: QuotaWindow[] | null, hint: QuotaReadHint): LiveProviderProbe {
  return windows?.length ? { windows } : { windows: null, hint };
}

/**
 * Fetch live windows for one adapter row. `windows: null` = keep
 * local/unknown only; `hint` diz por que a leitura não veio.
 */
export async function fetchLiveProviderWindows(
  adapterId: string,
  accountId: string | undefined,
  deps: LiveUsageAuthResolvers,
  now = Date.now(),
  declaredUpstream?: string,
  authMode = 'unknown',
): Promise<LiveProviderProbe> {
  const fetchImpl = deps.fetchImpl;
  if (declaredUpstream) {
    // API-key billing has no equivalent subscription quota on these routes.
    // Never substitute the computer's OAuth session for this credential mode.
    if (['claude', 'anthropic', 'codex', 'openai'].includes(declaredUpstream)) {
      return { windows: null };
    }
    const key = await deps.resolveApiQuotaKey?.({ adapterId, accountId, usageProviderId: declaredUpstream, authMode });
    return key
      ? asProbe(await fetchWindowsForApiKey(key, { fetchImpl, now, adapterHint: declaredUpstream }), 'unavailable')
      : NO_CREDENTIAL;
  }

  switch (adapterId) {
    case 'claude': {
      let hadToken = false;
      let oauthDead = false;
      if (deps.resolveClaudeToken) {
        const token = await Promise.resolve(deps.resolveClaudeToken(accountId));
        if (token) {
          hadToken = true;
          const oauth = await probeClaudeOauthUsage(token, {
            fetchImpl,
            now,
          });
          if (oauth.windows) return { windows: oauth.windows };
          // 401/403 = grant morto no servidor — sinal definitivo de que a
          // credencial desta identidade precisa de re-login.
          oauthDead = oauth.failure === 'auth-expired';
        }
      }
      // OAuth falhou (429/backoff, keychain rodada) ou sem token.
      // Row pinada: a cascata por conta (Codenotch — auth gerenciada scoped,
      // perfil de disco com o mesmo e-mail, materialização do vault) só usa
      // fontes ancoradas na identidade DESTA conta; sem ela, null honesto.
      // Row nativa: print-only `claude /usage` do login do CLI — que é de
      // UMA conta, nunca pintado em rows vault. Sem runner injetado NÃO
      // spawnamos o binário: testes ficam em null honesto.
      if (accountId) {
        if (!deps.claudeAccountUsage) return hadToken ? UNAVAILABLE : NO_CREDENTIAL;
        return deps.claudeAccountUsage(accountId);
      }
      // Sem token resolvível (ou token nativo vencido — o refresh da
      // linhagem nativa é do CLI, não nosso): o `oauthAccount` no
      // ~/.claude.json distingue «sessão morreu» de «nunca conectou».
      const sessionEvidence = deps.claudeNativeSession?.() === true;
      const tokenExpired = deps.claudeNativeTokenExpired?.() === true;
      const noTokenHint: QuotaReadHint =
        oauthDead || tokenExpired
          ? 'auth-expired'
          : hadToken
            ? 'unavailable'
            : sessionEvidence
              ? 'auth-expired'
              : 'no-credential';
      if (!deps.claudeCliUsage) return { windows: null, hint: noTokenHint };
      const probe = await deps.claudeCliUsage();
      if (probe.windows?.length) return { windows: probe.windows };
      // O motivo (auth-expired/cli-missing) vira hint acionável — a linha
      // nativa também precisa dizer «Entrar novamente», não só «—». O 401
      // do endpoint e a evidência de sessão são os sinais mais fortes:
      // valem mesmo quando o `/usage` sai quieto (só tabela de custo).
      return {
        windows: null,
        hint:
          probe.failure === 'auth-expired' || oauthDead || tokenExpired
            ? 'auth-expired'
            : probe.failure === 'cli-missing'
              ? 'cli-missing'
              : noTokenHint,
      };
    }
    case 'codex': {
      let candidates: CodexChatGptAuth[] = [];
      if (deps.resolveCodexAuthCandidates) {
        candidates = await Promise.resolve(
          deps.resolveCodexAuthCandidates(accountId),
        );
      } else if (deps.resolveCodexAuth) {
        const one = await Promise.resolve(deps.resolveCodexAuth(accountId));
        if (one) candidates = [one];
      }
      if (candidates.length === 0) return NO_CREDENTIAL;
      for (const auth of candidates) {
        const windows = await fetchCodexUsageWindows(auth, { fetchImpl, now });
        if (windows && windows.length > 0) return { windows };
      }
      return UNAVAILABLE;
    }
    case 'glm': {
      const keys = await stringCandidates(
        deps.resolveGlmApiKeyCandidates,
        deps.resolveGlmApiKey,
        accountId,
      );
      if (keys.length === 0) return NO_CREDENTIAL;
      for (const key of keys) {
        const windows = await fetchWindowsForApiKey(key, { fetchImpl, now, adapterHint: 'glm' });
        if (windows && windows.length > 0) return { windows };
      }
      return UNAVAILABLE;
    }
    case 'longcat': {
      const keys = await stringCandidates(
        deps.resolveLongcatApiKeyCandidates,
        deps.resolveLongcatApiKey,
        accountId,
      );
      if (keys.length === 0) return NO_CREDENTIAL;
      for (const key of keys) {
        const w = await fetchWindowsForApiKey(key, {
          fetchImpl,
          now,
          adapterHint: 'longcat',
        });
        if (w?.length) return { windows: w };
      }
      return UNAVAILABLE;
    }
    case 'grok': {
      const tokens = await stringCandidates(
        deps.resolveGrokTokenCandidates,
        deps.resolveGrokToken,
        accountId,
      );
      if (tokens.length === 0) return NO_CREDENTIAL;
      for (const token of tokens) {
        const windows = await fetchGrokUsageWindows(token, { fetchImpl, now });
        if (windows && windows.length > 0) return { windows };
      }
      return UNAVAILABLE;
    }
    case 'devin': {
      const key = deps.resolveDevinApiKey
        ? await Promise.resolve(deps.resolveDevinApiKey(accountId))
        : resolveDevinApiKey();
      if (!key) return NO_CREDENTIAL;
      return asProbe(await fetchDevinUsageWindows(key, { fetchImpl, now }), 'unavailable');
    }
    case 'cursor-agent': {
      // Sessão local do editor/`cursor-agent login` (só leitura) + usage-summary.
      return asProbe(
        await fetchCursorUsageWindowsLive({ fetchImpl, now }),
        'unavailable',
      );
    }
    case 'kimi': {
      let sawCredential = false;
      // 1) OAuth from ~/.kimi-code (same as `kimi login`) — refresh if expired.
      if (deps.resolveKimiOauthCreds) {
        const oauth = await Promise.resolve(
          deps.resolveKimiOauthCreds(accountId),
        );
        if (oauth?.refreshToken || oauth?.accessToken) {
          sawCredential = true;
          // Access expirado + refresh válido não pode ficar vazio (conta com
          // consumo aparecia «—»). Refresca em memória; se o servidor ROTACIONAR
          // o grant, persistOnRotation devolve o refresh token novo ao
          // ~/.kimi-code do CLI — consumi-lo sem gravar derruba o login nativo.
          const w = await fetchKimiUsageWithOauth(oauth, {
            fetchImpl,
            now,
            allowRefresh: true,
            persistRefresh: false,
            persistOnRotation: true,
          });
          if (w?.length) return { windows: w };
        }
      }
      // 2) API keys (sk-kimi-…) + any bare tokens.
      const tokens = await stringCandidates(
        deps.resolveKimiTokenCandidates,
        deps.resolveKimiToken,
        accountId,
      );
      if (tokens.length > 0) sawCredential = true;
      for (const token of tokens) {
        const coding = await fetchKimiCodingUsageWindows(token, {
          fetchImpl,
          now,
        });
        if (coding && coding.length > 0) return { windows: coding };
        const windows = await fetchKimiUsageWindows(token, { fetchImpl, now });
        if (windows && windows.length > 0) return { windows };
      }
      return sawCredential ? UNAVAILABLE : NO_CREDENTIAL;
    }
    case 'agy': {
      // Codenotch AntigravityBridge primeiro: o language server local (IDE
      // ou `agy` CLI rodando) já detém a credencial e a identidade de cliente
      // que o Google exige — contas pessoais tomam 403 "no valid license" no
      // endpoint direto. Só a linha nativa (sem accountId): a leitura é da
      // conta que o processo está logado, não atribuível a uma conta vault.
      if (!accountId) {
        const bridged = await fetchAgyBridgeUsage({ now }).catch(() => null);
        if (bridged && bridged.length > 0) return { windows: bridged };
      }
      let creds: GeminiOauthCreds | null = null;
      if (deps.resolveGeminiOauthCreds) {
        creds = await Promise.resolve(deps.resolveGeminiOauthCreds(accountId));
      } else if (deps.resolveGeminiToken) {
        const access = await Promise.resolve(deps.resolveGeminiToken(accountId));
        if (access) creds = { accessToken: access };
      }
      if (!creds) return NO_CREDENTIAL;
      // Access expirado + refresh válido não pode ficar vazio (mesmo buraco do
      // Kimi). O refresh Google devolve access novo em memória — o grant do
      // ~/.gemini do CLI não é rotacionado nem consumido por isso.
      return asProbe(
        await fetchAgyUsageWindows(creds, { fetchImpl, now, allowRefresh: true }),
        'unavailable',
      );
    }
    case 'opencode': {
      return fetchOpenCodeFleetWindows(deps, accountId, fetchImpl, now);
    }
    case 'aider': {
      // Aider is multi-provider: try every stored key (Anthropic/OpenAI/…).
      return fetchMultiKeyWindows(
        'aider',
        deps,
        accountId,
        fetchImpl,
        now,
      );
    }
    default: {
      // Any future / custom CLI: generic vault+launcher key routing.
      return fetchMultiKeyWindows(
        adapterId,
        deps,
        accountId,
        fetchImpl,
        now,
      );
    }
  }
}

async function fetchMultiKeyWindows(
  adapterId: string,
  deps: LiveUsageAuthResolvers,
  accountId: string | undefined,
  fetchImpl: FetchLike | undefined,
  now: number,
): Promise<LiveProviderProbe> {
  const keys: string[] = [];
  if (deps.resolveGenericApiKeyCandidates) {
    const list = await Promise.resolve(
      deps.resolveGenericApiKeyCandidates(adapterId, accountId),
    );
    for (const k of list ?? []) {
      if (k?.trim() && !keys.includes(k.trim())) keys.push(k.trim());
    }
  }
  // Also try adapter-specific resolvers when present
  if (adapterId === 'longcat') {
    for (const k of await stringCandidates(
      deps.resolveLongcatApiKeyCandidates,
      deps.resolveLongcatApiKey,
      accountId,
    )) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length === 0) return NO_CREDENTIAL;
  const sets: QuotaWindow[][] = [];
  for (const key of keys) {
    const w = await fetchWindowsForApiKey(key, {
      fetchImpl,
      now,
      adapterHint: adapterId,
    });
    if (w?.length) sets.push(w);
  }
  if (sets.length === 0) return UNAVAILABLE;
  const merged = mergeWorstWindows(sets);
  return merged.length > 0 ? { windows: merged } : UNAVAILABLE;
}

async function fetchOpenCodeFleetWindows(
  deps: LiveUsageAuthResolvers,
  accountId: string | undefined,
  fetchImpl: FetchLike | undefined,
  now: number,
): Promise<LiveProviderProbe> {
  const keys = new Map<string, string | undefined>();
  // ONLY keys the user actually connected inside OpenCode auth.json —
  // never steal glm/kimi/claude keys from the launcher and paint them as
  // "OpenCode" when the user never installed/used OpenCode.
  for (const e of accountId ? [] : loadOpenCodeAuthKeys()) {
    if (!keys.has(e.key)) keys.set(e.key, e.providerId);
  }
  // Optional: vault key stored under adapter id "opencode" itself.
  if (deps.resolveGenericApiKeyCandidates) {
    const list = await Promise.resolve(
      deps.resolveGenericApiKeyCandidates('opencode', accountId),
    );
    for (const k of list ?? []) {
      if (k?.trim() && !keys.has(k.trim())) keys.set(k.trim(), undefined);
    }
  }
  if (keys.size === 0) return NO_CREDENTIAL;
  const sets: QuotaWindow[][] = [];
  for (const [key, adapterHint] of keys) {
    const w = await fetchWindowsForApiKey(key, { fetchImpl, now, adapterHint });
    if (w?.length) sets.push(w);
  }
  if (sets.length === 0) return UNAVAILABLE;
  const merged = mergeWorstWindows(sets);
  return merged.length > 0 ? { windows: merged } : UNAVAILABLE;
}

/**
 * Best-effort Kimi Coding usage. Returns null on any failure.
 */
export async function fetchKimiUsageWindows(
  accessToken: string,
  opts?: { fetchImpl?: FetchLike; now?: number; timeoutMs?: number },
): Promise<QuotaWindow[] | null> {
  const token = accessToken?.trim();
  if (!token) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const urls = [
    'https://api.kimi.com/coding/v1/usages',
    'https://www.kimi.com/api/usage',
  ];

  try {
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const body = await res.json();
        const windows = parseKimiUsage(body, now);
        if (windows.length > 0) return windows;
      } catch {
        // try next
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseKimiUsage(body: unknown, now = Date.now()): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const data =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;

  const out: QuotaWindow[] = [];

  const tryPercent = (
    raw: unknown,
    kind: 'hours' | 'weekly' | 'session',
    label: string,
  ): void => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
    const ratio = Math.max(0, Math.min(1, raw / 100));
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio: ratio,
        source: 'provider-api',
        confidence: 'medium',
        now,
      }),
    );
  };

  for (const [key, kind, label] of [
    ['five_hour_usage_percent', 'hours', '5 Horas'],
    ['five_hour_percent', 'hours', '5 Horas'],
    ['usage_percent_5h', 'hours', '5 Horas'],
    ['weekly_usage_percent', 'weekly', 'Semanal'],
    ['week_percent', 'weekly', 'Semanal'],
    ['usage_percent_7d', 'weekly', 'Semanal'],
  ] as const) {
    if (key in data) tryPercent(data[key], kind, label);
  }

  const rl = data.rate_limit;
  if (rl && typeof rl === 'object') {
    const r = rl as Record<string, unknown>;
    const primary = r.primary_window;
    if (primary && typeof primary === 'object') {
      const pw = primary as Record<string, unknown>;
      if (typeof pw.used_percent === 'number') {
        tryPercent(pw.used_percent, 'weekly', 'Semanal');
      }
    }
  }

  return out;
}
