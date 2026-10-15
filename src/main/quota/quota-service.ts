/**
 * In-memory fleet quota service. Builds ProviderQuotaEntry[] from installed
 * adapters + vault accounts + limit/cooldown signals + live provider APIs
 * (Claude, Codex, GLM, Kimi best-effort, …). Broadcasts coalesced snapshots.
 * O(accounts), not O(panes). Never invents usedRatio without a source.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { handleTrusted } from '../security/trusted-ipc';
import { closeMimoQuotaConnections, connectMimoQuota, fetchMimoAccountUsage } from './mimo-console-session';
import {
  QUOTA_CHANNELS,
  compareEntriesByConsumption,
  type AccountPlan,
  type ProviderQuotaEntry,
  type QuotaFleetSnapshot,
  type QuotaReadHint,
  type QuotaWindow,
} from '../../shared/quota-types';
import type { LimitHit } from '../orch/limit-detector';
import { detectLimit } from '../orch/limit-detector';
import type { FailoverReasonKind } from '../../shared/account-types';
import { providerApiRefutesCooldown } from '../orch/limit-refutation';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { buildFleetSnapshot } from './quota-policy';
import { defaultUnknownWindows, mergeWindows } from './quota-normalize';
import { probeProviderWindows } from './quota-probes';
import {
  probeClaudeCliUsage,
  type ClaudeCliUsageProbe,
  type FetchLike,
} from './claude-oauth-usage';
import { fetchClaudeAccountUsageWindows } from './claude-account-usage';
import {
  claudeNativeAccessTokenExpiresAt,
  hasClaudeNativeSession,
  fetchCodexAccountUsage,
  persistKimiRotatedCreds as persistKimiRotatedCredsAuth,
} from './provider-usage-auth';
import { fetchGrokAccountUsage } from './grok-account-usage';
import { PLAN_CAPABLE_ADAPTERS } from './account-plan';
import { isCurrentProcessSmokeTest } from '../smoke-core';
import type { CodexChatGptAuth } from './codex-usage';
import {
  fetchLiveProviderWindows,
  type LiveUsageAuthResolvers,
  type LiveProviderProbe,
} from './provider-live-usage';
import { stopMissionQuotaPoll } from './mission-quota-poll';

/** Cache live API windows briefly — avoid hammering providers on every paint. */
const PROVIDER_API_TTL_MS = 60_000;

/**
 * F-1417: sondas que custam uma inferência real por leitura. A do Muse é um
 * POST de geração (a Meta não publica endpoint de uso): a 60 s eram 60
 * gerações por hora debitadas da própria janela que ela mede.
 */
const PROVIDER_API_TTL_BY_ADAPTER: Readonly<Record<string, number>> = {
  muse: 5 * 60_000,
};

export function providerApiTtlMs(adapterId: string): number {
  return Math.max(PROVIDER_API_TTL_MS, PROVIDER_API_TTL_BY_ADAPTER[adapterId] ?? 0);
}

/**
 * Backoff após uma observação que falhou (rede, auth, rate limit — ex. o
 * /api/oauth/usage do Claude responde 429 sob uso pesado). Sem isso cada
 * refresh re-tenta na hora e a martelada sustenta o próprio rate limit:
 * a entry fica unknown para sempre justamente quando o provider está
 * apertado. Sucesso limpa o backoff.
 */
const PROBE_FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * Sondas de conta em voo ao mesmo tempo (F-676). Várias abrem um processo de
 * CLI por conta (`claude /usage`, `codex app-server`, `grok agent`): com
 * 20–100 contas, disparar todas juntas travava a máquina e estourava o rate
 * limit do provider exatamente na hora da troca de conta.
 */
export const QUOTA_PROBE_CONCURRENCY = 6;

/** Roda `task` em cada item com no máximo `limit` em voo; preserva erros por item. */
export async function forEachWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item as T);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Every fleet CLI is eligible for a live/generic probe. Unknown adapters
 * still go through key-shape routing (OpenCode/Aider/custom).
 */
const LIVE_PROBE_ADAPTERS: ReadonlySet<string> | 'all' = 'all';

export interface QuotaServiceDeps {
  mimoAccountUsage?: LiveUsageAuthResolvers['mimoAccountUsage'];
  codexAccountUsage?: LiveUsageAuthResolvers['codexAccountUsage'];
  resolveApiQuotaKey?: LiveUsageAuthResolvers['resolveApiQuotaKey'];
  listProviders: () => ProviderSettingsInfo[] | Promise<ProviderSettingsInfo[]>;
  listAccounts: () => AccountInfo[] | Promise<AccountInfo[]>;
  /** Optional token totals by adapterId for Ollama local bars. */
  tokensByAdapter?: () =>
    | Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
    | Promise<
        Record<
          string,
          { inputTokens: number; outputTokens: number; costUsd: number }
        >
      >;
  /**
   * Resolve Claude OAuth access token for live /api/oauth/usage probe.
   * accountId set → vault account; omitted → active CLI login.
   */
  resolveClaudeAccessToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  /**
   * Native-row fallback `claude /usage` (print-only). Production (main.ts)
   * wires the real runner. Tests omit it so probes never spawn the host CLI.
   */
  claudeCliUsage?: () => Promise<ClaudeCliUsageProbe>;
  /** Evidência de login nativo Claude prévio (`oauthAccount` no ~/.claude.json). */
  claudeNativeSession?: () => boolean | Promise<boolean>;
  /** Access token nativo vencido (expiresAt cliente — refresh é do CLI). */
  claudeNativeTokenExpired?: () => boolean;
  /**
   * Per-account Claude fallback (Codenotch): managed-auth scoped CLI, perfil
   * de disco com o mesmo e-mail, materialização do vault. Só rows pinadas;
   * produção liga o runner real em main.ts.
   */
  claudeAccountUsage?: (
    accountId: string,
  ) => Promise<{ windows: QuotaWindow[] | null; hint?: QuotaReadHint }>;
  /**
   * A sonda de quota detectou grant morto ('auth-expired') numa conta — a UI
   * liga o flag de reautenticação (needsRelogin) sem esperar um 401 de spawn.
   * Produção liga no account-store (cooldown de auth). Opcional em testes.
   */
  markAccountAuthExpired?: (
    accountId: string,
    adapterId: string,
    reason?: 'auth-expired' | 'identity-mismatch',
  ) => void;
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
  grokAccountUsage?: (accountId?: string) => Promise<LiveProviderProbe>;
  resolveGrokToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGrokTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveKimiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveKimiTokenCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveKimiOauthCreds?: (
    accountId?: string,
  ) =>
    | { accessToken?: string; refreshToken?: string; expiresAt?: number }
    | null
    | Promise<{
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      } | null>;
  /** Write-back do grant Kimi rotacionado no vault da conta (linha pinada). */
  persistKimiRotatedCreds?: (
    accountId: string,
    rotated: { accessToken: string; refreshToken?: string; expiresIn?: number },
  ) => void;
  resolveGeminiToken?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveGeminiOauthCreds?: (
    accountId?: string,
  ) =>
    | { accessToken?: string; refreshToken?: string; expiryDate?: number }
    | null
    | Promise<{
        accessToken?: string;
        refreshToken?: string;
        expiryDate?: number;
      } | null>;
  resolveLongcatApiKey?: (
    accountId?: string,
  ) => string | null | Promise<string | null>;
  resolveLongcatApiKeyCandidates?: (
    accountId?: string,
  ) => string[] | Promise<string[]>;
  resolveGenericApiKeyCandidates?: (
    adapterId: string,
    accountId?: string,
  ) => string[] | Promise<string[]>;
  /** Prova pública de login do `mcode` (estado sem token). */
  minimaxCodeSignedIn?: () => boolean;
  /** Access token vigente do `mcode login` e sua região, só para a cota. */
  resolveMinimaxCodeLogin?: () => { accessToken: string; region: 'en' | 'cn' } | null;
  /** Credencial da assinatura Muse (`muse login`), só para a sonda de cota. */
  resolveMuseCredential?: LiveUsageAuthResolvers['resolveMuseCredential'];
  /** Prova pública de sessão Muse (sem tocar o segredo). */
  museSignedIn?: () => boolean;
  /** Access token OAuth do login nativo OpenClaude. */
  resolveOpenClaudeToken?: LiveUsageAuthResolvers['resolveOpenClaudeToken'];
  /** Fallback print-only `openclaude /usage`. */
  openclaudeCliUsage?: LiveUsageAuthResolvers['openclaudeCliUsage'];
  /** Prova pública de sessão OpenClaude. */
  openclaudeSignedIn?: LiveUsageAuthResolvers['openclaudeSignedIn'];
  /**
   * Detecção de plano de assinatura por linha (tier do provider → USD/mês de
   * lista quando mapeado). Produção liga `detectProviderPlan`; testes omitem
   * e as linhas ficam sem `plan` (resumo `undetected` honesto).
   */
  detectProviderPlan?: (
    adapterId: string,
    accountId?: string,
  ) => AccountPlan | null | Promise<AccountPlan | null>;
  /**
   * Limpa o cooldown de uma conta refutado por leitura provider-api fresca e
   * saudável (resíduo da cascata de limite fantasma). Opcional; produção liga
   * no account-store.clearCooldown.
   */
  clearRefutedAuthCooldown?: (accountId: string, adapterId: string) => void;
  clearRefutedCooldown?: (accountId: string, adapterId: string) => void;
  /**
   * Sink opcional do Nexus Redline (app de menu bar): recebe o snapshot assim
   * que ele vira `lastSnapshot`. Best-effort — falha do sink nunca afeta o
   * serviço (produção liga no redline-sink, que coalesce e grava atômico).
   */
  persistSnapshot?: (
    snap: QuotaFleetSnapshot,
    accounts: AccountInfo[],
  ) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
}

interface EntryKey {
  adapterId: string;
  accountId?: string;
}

/** Stored limit signal with observation time so cooldown can expire. */
export interface RecordedLimitHit {
  hit: LimitHit;
  /** Epoch ms when the hit was noted. */
  at: number;
}

interface CachedApiWindows {
  windows: QuotaWindow[];
  at: number;
  usageProviderId?: string;
  authMode: string;
  /** F-720: id opaco da credencial que leu as janelas (vira `quotaGroup`). */
  credentialId?: string;
}

/** Plano detectado — TTL longo: assinatura muda por mês, não por minuto. */
const PLAN_CACHE_TTL_MS = 60 * 60 * 1000;

interface ProbeIdentity extends EntryKey {
  usageProviderId?: string;
  authMode: string;
  canProbe: boolean;
  active?: boolean;
}

function apiCacheKey(input: ProbeIdentity): string {
  return JSON.stringify([input.adapterId, input.accountId ?? null, input.usageProviderId ?? null, input.authMode, input.canProbe]);
}

function canProbeQuota(provider: ProviderSettingsInfo | undefined, account?: AccountInfo): boolean {
  if (!provider || (account && account.adapterId !== provider.adapterId)) return false;
  if (account?.mode === 'subscription') return true;
  // Linha nativa por assinatura: a sonda é o OAuth/CLI do PRÓPRIO provider —
  // o `upstream` declara o formato da API de roteamento (moonshot etc.), não
  // a dona da quota. Sem este bypass, kimi (upstream 'moonshot') nunca é
  // sondado e fica «Sem informação» mesmo com sessão viva em ~/.kimi-code.
  if (!account && provider.authStrategy === 'subscription') return true;
  const upstream = (account?.upstream ?? provider.upstream)?.trim();
  return !upstream || upstream === 'anthropic' || provider.routable === true;
}

function declaredQuotaUpstream(provider: ProviderSettingsInfo | undefined, account?: AccountInfo): string | undefined {
  if (!canProbeQuota(provider, account)) return undefined;
  if (account && account.mode !== 'api-key') return undefined;
  const owner = provider?.adapterId ?? account?.adapterId;
  if (provider?.routable) {
    const upstream = (account?.upstream ?? provider.upstream)?.trim();
    if (upstream && upstream !== 'anthropic' && upstream !== owner) return upstream;
  }
  return (account?.mode ?? provider?.authStrategy) === 'api-key' ? owner : undefined;
}

function quotaAuthMode(provider: ProviderSettingsInfo | undefined, account?: AccountInfo): string {
  return account?.mode ?? provider?.authStrategy ?? 'unknown';
}

function entryId(k: EntryKey): string {
  return k.accountId ? `${k.adapterId}:${k.accountId}` : k.adapterId;
}

export class QuotaService {
  readonly #deps: QuotaServiceDeps;
  readonly #limitByKey = new Map<string, RecordedLimitHit>();
  /** Live provider-api windows by entry id. */
  readonly #apiCache = new Map<string, CachedApiWindows>();
  /**
   * Último plano detectado por linha (`adapter:account`). Leituras falhas não
   * apagam o valor anterior — plano é fato de conta, não de sonda.
   */
  readonly #planCache = new Map<string, { plan: AccountPlan | null; at: number }>();
  /** Entry id → epoch ms até quando a probe falhou deve esperar para voltar. */
  readonly #probeBackoffUntil = new Map<string, number>();
  /**
   * Motivo da última falha de sonda por linha — sobrevive ao backoff para a
   * UI continuar dizendo «sessão expirada» em vez de voltar ao «—» mudo.
   * Apagado na primeira leitura boa.
   */
  readonly #probeHints = new Map<string, QuotaReadHint>();
  #broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSnapshot: QuotaFleetSnapshot | null = null;
  #stopped = false;
  /** In-flight refresh coalescing. */
  #snapshotInFlight: {
    generation: number;
    forced: boolean;
    startedAt: number;
    promise: Promise<QuotaFleetSnapshot>;
  } | null = null;
  #snapshotGeneration = 0;
  #lastSnapshotGeneration = 0;

  constructor(deps: QuotaServiceDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;
    this.#snapshotGeneration += 1;
    if (this.#broadcastTimer) {
      clearTimeout(this.#broadcastTimer);
      this.#broadcastTimer = null;
    }
    this.#apiCache.clear();
  }

  /**
   * Record a limit hit for adapter/account (from failover path).
   * `at` defaults to now; pass explicitly in tests for deterministic expiry.
   */
  noteLimitHit(
    adapterId: string,
    hit: LimitHit,
    accountId?: string,
    at = Date.now(),
  ): void {
    if (this.#stopped) return;
    const id = entryId({ adapterId, accountId });
    this.#limitByKey.set(id, { hit, at });
    this.#scheduleBroadcast();
  }

  /**
   * Active recorded hit for a key, or null if missing/expired.
   * Drops expired entries so they cannot re-exhaust forever.
   *
   * Per-account rows never fall back to bare adapterId hits — that would
   * mark every vault account exhausted from a single unpinned signal.
   */
  #activeRecordedHit(
    adapterId: string,
    accountId: string | undefined,
    now: number,
  ): RecordedLimitHit | null {
    const key = accountId
      ? entryId({ adapterId, accountId })
      : adapterId;
    const rec = this.#limitByKey.get(key);
    if (!rec) return null;
    if (now >= rec.at + rec.hit.cooldownMs) {
      this.#limitByKey.delete(key);
      return null;
    }
    return rec;
  }

  async snapshot(
    now = Date.now(),
    opts?: {
      forceApi?: boolean;
      /**
       * Aceita uma leitura FORÇADA já em voo que começou neste instante ou
       * depois (F-676). Uma rajada de N panes batendo no limite fazia N
       * sondagens da frota inteira; leitura anterior ao hit nunca serve —
       * poderia "refutar" um limite que ainda não existia quando ela saiu.
       */
      shareForcedSince?: number;
    },
  ): Promise<QuotaFleetSnapshot> {
    // Coalesce concurrent snapshot() so one open of Settings doesn't fan-out
    // N parallel Anthropic calls.
    const inFlight = this.#snapshotInFlight;
    if (
      inFlight &&
      (!opts?.forceApi ||
        (opts.shareForcedSince !== undefined &&
          inFlight.forced &&
          inFlight.startedAt >= opts.shareForcedSince))
    ) {
      return inFlight.promise;
    }
    const generation = ++this.#snapshotGeneration;
    const forced = opts?.forceApi === true;
    const run = this.#buildSnapshot(now, forced, generation);
    const flight = {
      generation,
      forced,
      startedAt: Date.now(),
      promise: this.#resolveCurrentSnapshot(run, generation),
    };
    this.#snapshotInFlight = flight;
    try {
      return await flight.promise;
    } finally {
      if (this.#snapshotInFlight === flight) this.#snapshotInFlight = null;
    }
  }

  async #resolveCurrentSnapshot(run: Promise<QuotaFleetSnapshot>, generation: number): Promise<QuotaFleetSnapshot> {
    const snapshot = await run;
    while (generation !== this.#snapshotGeneration) {
      const latest = this.#snapshotInFlight;
      if (latest && latest.generation !== generation) { await latest.promise; continue; }
      if (this.#lastSnapshot && this.#lastSnapshotGeneration === this.#snapshotGeneration) return this.#lastSnapshot;
      throw new Error('quota refresh was superseded or stopped');
    }
    return snapshot;
  }

  async #buildSnapshot(
    now: number,
    forceApi: boolean,
    generation: number,
  ): Promise<QuotaFleetSnapshot> {
    const [providers, accounts] = await Promise.all([
      Promise.resolve(this.#deps.listProviders()),
      Promise.resolve(this.#deps.listAccounts()),
    ]);
    const tokens = this.#deps.tokensByAdapter
      ? await Promise.resolve(this.#deps.tokensByAdapter())
      : {};

    const draft: Array<{
      adapterId: string;
      usageProviderId?: string;
      authMode: string;
      canProbe: boolean;
      accountId?: string;
      active?: boolean;
      label: string;
      installed: boolean;
      onCooldown: boolean;
      cooldownKind?: FailoverReasonKind;
      cooldownUntil?: number;
      tokens?: { inputTokens: number; outputTokens: number; costUsd: number };
    }> = [];

    // Only CLIs the user actually has reason to care about:
    // enabled + (installed on PATH and has credentials/active session, vault account, or local token spend).
    // Never invent rows for unused adapters (e.g. OpenCode/Aider installed but never configured).
    const fleet = providers.filter((p) => {
      if (p.enabled === false) return false;

      // 1. Has active vault account or local token spend
      if (accounts.some((a) => a.adapterId === p.adapterId)) return true;
      const tok = tokens[p.adapterId];
      if (tok && tok.inputTokens + tok.outputTokens > 0) return true;

      // A cold native-auth observation must not prevent its quota resolver
      // from checking the credential asynchronously.
      if (p.installed && (p.authStrategy !== 'login-needed' || p.authState === 'unknown')) return true;

      return false;
    });

    for (const p of fleet) {
      const vault = accounts.filter((a) => a.adapterId === p.adapterId);
      if (vault.length === 0) {
        draft.push({
          adapterId: p.adapterId,
          usageProviderId: declaredQuotaUpstream(p),
          authMode: quotaAuthMode(p),
          canProbe: canProbeQuota(p),
          label: p.label,
          installed: p.installed,
          onCooldown: false,
          tokens: tokens[p.adapterId],
        });
        continue;
      }
      const hasActiveVaultAccount = vault.some((a) => a.active);
      const vaultCoversNativeAuth = hasActiveVaultAccount || (
        vault.length > 0 &&
        vault.every((a) => a.mode === p.authStrategy)
      );

      // Bare system/CLI row only when the native login is distinct from vault rows
      // (e.g. native subscription session while vault only has API keys).
      if (!vaultCoversNativeAuth) {
        draft.push({
          adapterId: p.adapterId,
          usageProviderId: declaredQuotaUpstream(p),
          authMode: quotaAuthMode(p),
          canProbe: canProbeQuota(p),
          label: `${p.label} · CLI nativo`,
          installed: p.installed,
          onCooldown: false,
          tokens: tokens[p.adapterId],
        });
      }
      for (const a of vault) {
        draft.push({
          adapterId: p.adapterId,
          accountId: a.id,
          active: a.active,
          usageProviderId: declaredQuotaUpstream(p, a),
          authMode: quotaAuthMode(p, a),
          canProbe: canProbeQuota(p, a),
          label: `${p.label} · ${a.label}`,
          installed: p.installed,
          onCooldown: a.onCooldown,
          cooldownKind: a.lastError
            ? detectLimit(a.lastError)?.kind
            : undefined,
          cooldownUntil: a.cooldownUntil,
          tokens: tokens[p.adapterId],
        });
      }
    }

    for (const a of accounts) {
      if (draft.some((e) => e.accountId === a.id)) continue;
      const p = providers.find((x) => x.adapterId === a.adapterId);
      draft.push({
        adapterId: a.adapterId,
        accountId: a.id,
        active: a.active,
        usageProviderId: declaredQuotaUpstream(p, a),
        authMode: quotaAuthMode(p, a),
        canProbe: canProbeQuota(p, a),
        label: `${p?.label ?? a.adapterId} · ${a.label}`,
        installed: p?.installed ?? false,
        onCooldown: a.onCooldown,
        cooldownKind: a.lastError
          ? detectLimit(a.lastError)?.kind
          : undefined,
        cooldownUntil: a.cooldownUntil,
        tokens: tokens[a.adapterId],
      });
    }

    // Live provider APIs for every supported row (vault / keychain / launcher).
    const observations = await this.#hydrateLiveApiWindows(draft, now, forceApi, generation);

    const refreshedAccounts = await Promise.resolve(this.#deps.listAccounts());
    const entries: ProviderQuotaEntry[] = draft.map((d) =>
      this.#buildEntry({ ...d, now }, observations.get(apiCacheKey(d)), generation === this.#snapshotGeneration && !this.#stopped),
    );

    entries.sort(compareEntriesByConsumption);
    const snap = buildFleetSnapshot(entries, now);
    if (generation === this.#snapshotGeneration && !this.#stopped) {
      this.#lastSnapshot = snap;
      this.#lastSnapshotGeneration = generation;
      try {
        this.#deps.persistSnapshot?.(snap, refreshedAccounts);
      } catch {
        /* sink é best-effort: nunca derruba o snapshot */
      }
    }
    return snap;
  }

  #liveResolvers(): LiveUsageAuthResolvers {
    return {
      mimoAccountUsage: this.#deps.mimoAccountUsage ?? (process.env.VITEST ? undefined : fetchMimoAccountUsage),
      resolveApiQuotaKey: this.#deps.resolveApiQuotaKey,
      resolveClaudeToken: this.#deps.resolveClaudeAccessToken,
      claudeCliUsage:
        this.#deps.claudeCliUsage ??
        (this.#deps.fetchImpl || process.env.VITEST
          ? undefined
          : () => probeClaudeCliUsage({ now: Date.now() })),
      claudeNativeSession:
        this.#deps.claudeNativeSession ??
        (process.env.VITEST ? undefined : () => hasClaudeNativeSession()),
      claudeNativeTokenExpired:
        this.#deps.claudeNativeTokenExpired ??
        (process.env.VITEST
          ? undefined
          : () => {
              const exp = claudeNativeAccessTokenExpiresAt();
              return exp !== null && exp <= Date.now();
            }),
      claudeAccountUsage:
        this.#deps.claudeAccountUsage ??
        (this.#deps.fetchImpl || process.env.VITEST
          ? undefined
          : (accountId: string) => fetchClaudeAccountUsageWindows(accountId)),
      resolveCodexAuth: this.#deps.resolveCodexAuth,
      resolveCodexAuthCandidates: this.#deps.resolveCodexAuthCandidates,
      codexAccountUsage: this.#deps.codexAccountUsage ??
        (this.#deps.fetchImpl || process.env.VITEST ? undefined : fetchCodexAccountUsage),
      resolveGlmApiKey: this.#deps.resolveGlmApiKey,
      resolveGlmApiKeyCandidates: this.#deps.resolveGlmApiKeyCandidates,
      grokAccountUsage: this.#deps.grokAccountUsage ??
        (this.#deps.fetchImpl || process.env.VITEST ? undefined : fetchGrokAccountUsage),
      resolveGrokToken: this.#deps.resolveGrokToken,
      resolveGrokTokenCandidates: this.#deps.resolveGrokTokenCandidates,
      resolveKimiToken: this.#deps.resolveKimiToken,
      resolveKimiTokenCandidates: this.#deps.resolveKimiTokenCandidates,
      resolveKimiOauthCreds: this.#deps.resolveKimiOauthCreds,
      persistKimiRotatedCreds:
        this.#deps.persistKimiRotatedCreds ??
        (process.env.VITEST
          ? undefined
          : (accountId, rotated) =>
              persistKimiRotatedCredsAuth(accountId, rotated)),
      resolveGeminiToken: this.#deps.resolveGeminiToken,
      resolveGeminiOauthCreds: this.#deps.resolveGeminiOauthCreds,
      resolveLongcatApiKey: this.#deps.resolveLongcatApiKey,
      resolveLongcatApiKeyCandidates: this.#deps.resolveLongcatApiKeyCandidates,
      resolveGenericApiKeyCandidates: this.#deps.resolveGenericApiKeyCandidates,
      minimaxCodeSignedIn: this.#deps.minimaxCodeSignedIn,
      resolveMinimaxCodeLogin: this.#deps.resolveMinimaxCodeLogin,
      resolveMuseCredential: this.#deps.resolveMuseCredential,
      museSignedIn: this.#deps.museSignedIn,
      resolveOpenClaudeToken: this.#deps.resolveOpenClaudeToken,
      openclaudeCliUsage: this.#deps.openclaudeCliUsage,
      openclaudeSignedIn: this.#deps.openclaudeSignedIn,
      fetchImpl: this.#deps.fetchImpl,
    };
  }

  async #hydrateLiveApiWindows(
    draft: ReadonlyArray<ProbeIdentity>,
    now: number,
    forceApi: boolean,
    generation: number,
  ): Promise<Map<string, CachedApiWindows>> {
    const observations = new Map<string, CachedApiWindows>();
    // F-1004: sem sondas vivas de cota no smoke — elas leem o Keychain
    // (`security find-generic-password -w`) e executam claude/agy/cursor-agent.
    if (isCurrentProcessSmokeTest()) return observations;
    const rows =
      LIVE_PROBE_ADAPTERS === 'all'
        ? [...draft]
        : draft.filter((d) =>
            (LIVE_PROBE_ADAPTERS as ReadonlySet<string>).has(d.adapterId),
          );
    if (rows.length === 0) return observations;

    const resolvers = this.#liveResolvers();
    await forEachWithConcurrency(
      rows,
      QUOTA_PROBE_CONCURRENCY,
      async (row) => {
        if (!row.canProbe) return;
        const id = apiCacheKey(row);
        await this.#refreshPlan(row, now, forceApi, generation);
        if (!forceApi) {
          const cached = this.#apiCache.get(id);
          if (cached && now - cached.at < providerApiTtlMs(row.adapterId)) {
            observations.set(id, cached);
            return;
          }
          const backoffUntil = this.#probeBackoffUntil.get(id);
          if (backoffUntil !== undefined && now < backoffUntil) return;
        }
        try {
          const probe = await fetchLiveProviderWindows(
            row.adapterId,
            row.accountId,
            resolvers,
            now,
            row.usageProviderId,
            row.authMode,
          );
          if (probe.windows && probe.windows.length > 0) {
            if (row.accountId && generation === this.#snapshotGeneration && !this.#stopped &&
                probe.windows.some(w => w.source === 'provider-api' && w.usedRatio != null && Number.isFinite(w.usedRatio))) {
              try { this.#deps.clearRefutedAuthCooldown?.(row.accountId, row.adapterId); }
              catch { console.warn('[quota] não foi possível limpar o aviso de autenticação confirmado'); }
            }
            const observation: CachedApiWindows = {
              windows: probe.windows,
              at: now,
              usageProviderId: row.usageProviderId,
              authMode: row.authMode,
              ...(probe.credentialId ? { credentialId: probe.credentialId } : {}),
            };
            observations.set(id, observation);
            this.#probeBackoffUntil.delete(id);
            this.#probeHints.delete(id);
            if (generation === this.#snapshotGeneration && !this.#stopped) this.#apiCache.set(id, observation);
          } else if (generation === this.#snapshotGeneration && !this.#stopped) {
            // A failed observation cannot renew an expired percentage.
            this.#apiCache.delete(id);
            this.#probeBackoffUntil.set(id, now + PROBE_FAILURE_BACKOFF_MS);
            if (probe.hint) {
              this.#probeHints.set(id, probe.hint);
              if (
                (probe.hint === 'auth-expired' || probe.hint === 'identity-mismatch') &&
                row.accountId &&
                this.#deps.markAccountAuthExpired
              ) {
                try {
                  this.#deps.markAccountAuthExpired(row.accountId, row.adapterId, probe.hint);
                } catch {
                  /* marcação é best-effort — a linha já carrega o hint */
                }
              }
            }
          }
        } catch {
          if (generation === this.#snapshotGeneration && !this.#stopped) {
            this.#apiCache.delete(id);
            this.#probeBackoffUntil.set(id, now + PROBE_FAILURE_BACKOFF_MS);
          }
        }
      },
    );
    return observations;
  }

  /**
   * Detecção de plano por linha, com TTL próprio e keep-stale: uma falha de
   * leitura não apaga o plano que já conhecíamos (fato de conta, não sonda).
   */
  async #refreshPlan(
    row: ProbeIdentity,
    now: number,
    forceApi: boolean,
    generation: number,
  ): Promise<void> {
    if (!PLAN_CAPABLE_ADAPTERS.has(row.adapterId)) return;
    if (row.authMode === 'api-key' || row.usageProviderId) return;
    const detect = this.#deps.detectProviderPlan;
    if (!detect) return;
    const key = `${row.adapterId}:${row.accountId ?? ''}`;
    const held = this.#planCache.get(key);
    if (!forceApi && held && now - held.at < PLAN_CACHE_TTL_MS) return;
    try {
      const plan = await Promise.resolve(detect(row.adapterId, row.accountId));
      if (generation === this.#snapshotGeneration && !this.#stopped) {
        this.#planCache.set(key, { plan, at: now });
      }
    } catch {
      /* falha de detecção mantém o plano em cache — nunca inventa */
    }
  }

  lastSnapshot(): QuotaFleetSnapshot | null {
    return this.#lastSnapshot;
  }

  #buildEntry(input: {
    adapterId: string;
    usageProviderId?: string;
    accountId?: string;
    authMode?: string;
    active?: boolean;
    label: string;
    installed: boolean;
    onCooldown: boolean;
    cooldownKind?: FailoverReasonKind;
    cooldownUntil?: number;
    tokens?: { inputTokens: number; outputTokens: number; costUsd: number };
    canProbe?: boolean;
    now: number;
  }, api: CachedApiWindows | undefined, allowCooldownRefutation: boolean): ProviderQuotaEntry {
    const id = entryId({
      adapterId: input.adapterId,
      accountId: input.accountId,
    });
    const recorded = this.#activeRecordedHit(
      input.adapterId,
      input.accountId,
      input.now,
    );
    // F-1484: motivo sem frase de detector (StopFailure) — o tipo vem do hit
    // registrado, para a janela sintética e o peso de failover não sumirem.
    const cooldownKind = input.cooldownKind ?? recorded?.hit.kind;
    let windows = probeProviderWindows({
      adapterId: input.adapterId,
      accountId: input.accountId,
      onCooldown: input.onCooldown,
      cooldownKind,
      cooldownUntil: input.cooldownUntil,
      localTokens: input.tokens,
      lastLimitHit: recorded?.hit ?? null,
      lastLimitHitAt: recorded?.at,
      now: input.now,
    });
    if (api?.windows.length) {
      windows = mergeWindows(windows, api.windows);
    }
    if (windows.length === 0) {
      windows = defaultUnknownWindows(input.adapterId);
    }
    // Cooldown persistido × leitura provider-api fresca e saudável: o
    // cooldown é resíduo (cascata fantasma pré-fix ou reset antecipado do
    // provider) — limpa na conta e já entrega a entry destravada, em vez de
    // exibir "100% · 10h" numa conta comprovadamente ok.
    // Um cooldown com `cooldownUntil` já vencido nunca é reportado como ativo
    // (defesa em profundidade: o account-store expira, a entry não herda
    // resíduo).
    let onCooldown =
      input.onCooldown &&
      (input.cooldownUntil === undefined || input.cooldownUntil > input.now);
    let cooldownUntil = onCooldown ? input.cooldownUntil : undefined;
    // F-1484: cooldown posto por limite que o provedor confirmou (StopFailure)
    // não é apagado por leitura de antes da confirmação (cache de até 60 s).
    const confirmedAt = recorded?.hit.confirmedAt;
    if (
      onCooldown &&
      allowCooldownRefutation &&
      input.accountId &&
      this.#deps.clearRefutedCooldown &&
      api !== undefined &&
      (confirmedAt === undefined || api.at > confirmedAt) &&
      providerApiRefutesCooldown(api.windows, api.at, input.now)
    ) {
      this.#deps.clearRefutedCooldown(input.accountId, input.adapterId);
      onCooldown = false;
      cooldownUntil = undefined;
    }
    const planEligible =
      PLAN_CAPABLE_ADAPTERS.has(input.adapterId) &&
      input.authMode !== 'api-key' &&
      !input.usageProviderId;
    const plan = this.#planCache.get(
      `${input.adapterId}:${input.accountId ?? ''}`,
    )?.plan;
    const readHint = this.#probeHints.get(
      apiCacheKey({
        adapterId: input.adapterId,
        accountId: input.accountId,
        usageProviderId: input.usageProviderId,
        authMode: input.authMode ?? 'unknown',
        canProbe: input.canProbe ?? true,
      }),
    );
    return {
      id,
      adapterId: input.adapterId,
      accountId: input.accountId,
      ...(input.active !== undefined ? { active: input.active } : {}),
      label: input.label,
      ...(input.usageProviderId ? { usageProviderId: input.usageProviderId } : {}),
      ...(plan ? { plan } : {}),
      ...(planEligible ? { planEligible: true } : {}),
      installed: input.installed,
      onCooldown,
      ...(onCooldown && cooldownKind
        ? { cooldownKind }
        : {}),
      cooldownUntil,
      windows: mergeWindows(defaultUnknownWindows(input.adapterId), windows),
      ...(readHint ? { readHint } : {}),
      ...(api?.credentialId ? { quotaGroup: api.credentialId } : {}),
      updatedAt: api?.at ?? input.now,
    };
  }

  #scheduleBroadcast(): void {
    if (this.#broadcastTimer || this.#stopped) return;
    this.#broadcastTimer = setTimeout(() => {
      this.#broadcastTimer = null;
      void this.snapshot()
        .then((snap) => {
          if (this.#stopped || snap !== this.#lastSnapshot) return;
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isCrashed()) {
              win.webContents.send(QUOTA_CHANNELS.changed, snap);
            }
          }
        })
        .catch((err) => {
          console.warn('[quota] broadcast snapshot failed:', err);
        });
    }, 750);
    this.#broadcastTimer.unref?.();
  }

  /** Rebuild honoring the API/plan caches + broadcast (post-boot first read). */
  async publishSnapshot(): Promise<QuotaFleetSnapshot> {
    return this.#refreshAndPublish(await this.snapshot());
  }

  /** Force rebuild + live API re-probe + broadcast (UI refresh button). */
  async refresh(): Promise<QuotaFleetSnapshot> {
    return this.#refreshAndPublish(await this.snapshot(Date.now(), { forceApi: true }));
  }

  /**
   * Leitura forçada para confirmar um limite detectado em `hitAt` (F-676):
   * panes da mesma rajada dividem a sondagem que saiu depois do hit.
   */
  async refreshForLimitHit(hitAt: number): Promise<QuotaFleetSnapshot> {
    return this.#refreshAndPublish(
      await this.snapshot(Date.now(), { forceApi: true, shareForcedSince: hitAt }),
    );
  }

  #refreshAndPublish(snap: QuotaFleetSnapshot): QuotaFleetSnapshot {
    if (this.#stopped || snap !== this.#lastSnapshot) return snap;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isCrashed()) {
        win.webContents.send(QUOTA_CHANNELS.changed, snap);
      }
    }
    return snap;
  }
}

import {
  enqueuePostBootIdleTask,
  isPostBootIdleReady,
} from '../observability/post-boot-idle-queue';

const EMPTY_LAZY_QUOTA_SNAPSHOT: QuotaFleetSnapshot = Object.freeze({
  updatedAt: 0,
  entries: [],
  worstUsedRatio: null,
  highUsageCount: 0,
  unknownCount: 0,
});

let configured: QuotaService | null = null;
let lazyDepsFactory: (() => QuotaServiceDeps) | null = null;

function ensureQuotaService(): QuotaService | null {
  if (!configured && lazyDepsFactory) {
    const factory = lazyDepsFactory;
    lazyDepsFactory = null;
    configured = new QuotaService(factory());
  }
  return configured;
}

/**
 * First quota read off the boot path: a cache-honoring snapshot (no forced
 * fleet re-probe), then the broadcast the renderer waits for after it got
 * the empty lazy snapshot.
 */
function enqueueLazyQuotaInit(): void {
  enqueuePostBootIdleTask('initQuotaService', async () => {
    await ensureQuotaService()?.publishSnapshot();
  });
}

function registerQuotaIpcHandlers(): void {
  ipcMain.removeHandler(QUOTA_CHANNELS.snapshot);
  ipcMain.removeHandler(QUOTA_CHANNELS.refresh);
  ipcMain.removeHandler(QUOTA_CHANNELS.connectMimo);
  handleTrusted(QUOTA_CHANNELS.connectMimo, async (_event, input) => {
    const accountId = z.string().min(1).max(256).optional().parse(input);
    const result = await connectMimoQuota(accountId);
    await ensureQuotaService()?.refresh();
    return result;
  });
  ipcMain.handle(QUOTA_CHANNELS.snapshot, async () => {
    if (!configured && lazyDepsFactory && !isPostBootIdleReady()) {
      enqueueLazyQuotaInit();
      return EMPTY_LAZY_QUOTA_SNAPSHOT;
    }
    return requireQuotaService().snapshot();
  });
  ipcMain.handle(QUOTA_CHANNELS.refresh, async () => {
    if (!configured && lazyDepsFactory && !isPostBootIdleReady()) {
      enqueueLazyQuotaInit();
      return EMPTY_LAZY_QUOTA_SNAPSHOT;
    }
    return requireQuotaService().refresh();
  });
}

/**
 * Registra os canais IPC de quota no bootstrap e adia a instância de
 * `QuotaService` para o 1º uso (`requireQuotaService` / IPC pós-idle) ou para
 * a fila idle pós-boot.
 */
export function registerQuotaServiceLazy(depsFactory: () => QuotaServiceDeps): void {
  configured?.stop();
  configured = null;
  lazyDepsFactory = depsFactory;
  registerQuotaIpcHandlers();
  enqueueLazyQuotaInit();
}

export function initQuotaService(deps: QuotaServiceDeps): QuotaService {
  lazyDepsFactory = null;
  configured?.stop();
  configured = new QuotaService(deps);
  registerQuotaIpcHandlers();
  return configured;
}

export function requireQuotaService(): QuotaService {
  const service = ensureQuotaService();
  if (!service) throw new Error('quota service not initialized');
  return service;
}

export function noteQuotaLimitHit(
  adapterId: string,
  hit: LimitHit,
  accountId?: string,
): void {
  ensureQuotaService()?.noteLimitHit(adapterId, hit, accountId);
}

export function shutdownQuotaService(): void {
  // F-1483: o poll das contas na missão para junto com o serviço.
  stopMissionQuotaPoll();
  lazyDepsFactory = null;
  ipcMain.removeHandler(QUOTA_CHANNELS.connectMimo);
  closeMimoQuotaConnections();
  ipcMain.removeHandler(QUOTA_CHANNELS.snapshot);
  ipcMain.removeHandler(QUOTA_CHANNELS.refresh);
  configured?.stop();
  configured = null;
}
