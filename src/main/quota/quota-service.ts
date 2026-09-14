/**
 * In-memory fleet quota service. Builds ProviderQuotaEntry[] from installed
 * adapters + vault accounts + limit/cooldown signals + live provider APIs
 * (Claude, Codex, GLM, Kimi best-effort, …). Broadcasts coalesced snapshots.
 * O(accounts), not O(panes). Never invents usedRatio without a source.
 */

import { BrowserWindow, ipcMain } from 'electron';
import {
  QUOTA_CHANNELS,
  type ProviderQuotaEntry,
  type QuotaFleetSnapshot,
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
import type { FetchLike } from './claude-oauth-usage';
import type { CodexChatGptAuth } from './codex-usage';
import {
  fetchLiveProviderWindows,
  type LiveUsageAuthResolvers,
} from './provider-live-usage';

/** Cache live API windows briefly — avoid hammering providers on every paint. */
const PROVIDER_API_TTL_MS = 60_000;

/**
 * Every fleet CLI is eligible for a live/generic probe. Unknown adapters
 * still go through key-shape routing (OpenCode/Aider/custom).
 */
const LIVE_PROBE_ADAPTERS: ReadonlySet<string> | 'all' = 'all';

export interface QuotaServiceDeps {
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
  /**
   * Limpa o cooldown de uma conta refutado por leitura provider-api fresca e
   * saudável (resíduo da cascata de limite fantasma). Opcional; produção liga
   * no account-store.clearCooldown.
   */
  clearRefutedCooldown?: (accountId: string, adapterId: string) => void;
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
}

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
  #broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSnapshot: QuotaFleetSnapshot | null = null;
  #stopped = false;
  /** In-flight refresh coalescing. */
  #snapshotInFlight: { generation: number; promise: Promise<QuotaFleetSnapshot> } | null = null;
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
    opts?: { forceApi?: boolean },
  ): Promise<QuotaFleetSnapshot> {
    // Coalesce concurrent snapshot() so one open of Settings doesn't fan-out
    // N parallel Anthropic calls.
    if (this.#snapshotInFlight && !opts?.forceApi) {
      return this.#snapshotInFlight.promise;
    }
    const generation = ++this.#snapshotGeneration;
    const run = this.#buildSnapshot(now, opts?.forceApi === true, generation);
    const flight = { generation, promise: this.#resolveCurrentSnapshot(run, generation) };
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

    const entries: ProviderQuotaEntry[] = draft.map((d) =>
      this.#buildEntry({ ...d, now }, observations.get(apiCacheKey(d)), generation === this.#snapshotGeneration && !this.#stopped),
    );

    entries.sort((a, b) => a.label.localeCompare(b.label, 'pt'));
    const snap = buildFleetSnapshot(entries, now);
    if (generation === this.#snapshotGeneration && !this.#stopped) {
      this.#lastSnapshot = snap;
      this.#lastSnapshotGeneration = generation;
    }
    return snap;
  }

  #liveResolvers(): LiveUsageAuthResolvers {
    return {
      resolveApiQuotaKey: this.#deps.resolveApiQuotaKey,
      resolveClaudeToken: this.#deps.resolveClaudeAccessToken,
      resolveCodexAuth: this.#deps.resolveCodexAuth,
      resolveCodexAuthCandidates: this.#deps.resolveCodexAuthCandidates,
      resolveGlmApiKey: this.#deps.resolveGlmApiKey,
      resolveGlmApiKeyCandidates: this.#deps.resolveGlmApiKeyCandidates,
      resolveGrokToken: this.#deps.resolveGrokToken,
      resolveGrokTokenCandidates: this.#deps.resolveGrokTokenCandidates,
      resolveKimiToken: this.#deps.resolveKimiToken,
      resolveKimiTokenCandidates: this.#deps.resolveKimiTokenCandidates,
      resolveKimiOauthCreds: this.#deps.resolveKimiOauthCreds,
      resolveGeminiToken: this.#deps.resolveGeminiToken,
      resolveGeminiOauthCreds: this.#deps.resolveGeminiOauthCreds,
      resolveLongcatApiKey: this.#deps.resolveLongcatApiKey,
      resolveLongcatApiKeyCandidates: this.#deps.resolveLongcatApiKeyCandidates,
      resolveGenericApiKeyCandidates: this.#deps.resolveGenericApiKeyCandidates,
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
    const rows =
      LIVE_PROBE_ADAPTERS === 'all'
        ? [...draft]
        : draft.filter((d) =>
            (LIVE_PROBE_ADAPTERS as ReadonlySet<string>).has(d.adapterId),
          );
    if (rows.length === 0) return observations;

    const resolvers = this.#liveResolvers();
    await Promise.all(
      rows.map(async (row) => {
        if (!row.canProbe) return;
        const id = apiCacheKey(row);
        if (!forceApi) {
          const cached = this.#apiCache.get(id);
          if (cached && now - cached.at < PROVIDER_API_TTL_MS) {
            observations.set(id, cached);
            return;
          }
        }
        try {
          const windows = await fetchLiveProviderWindows(
            row.adapterId,
            row.accountId,
            resolvers,
            now,
            row.usageProviderId,
            row.authMode,
          );
          if (windows && windows.length > 0) {
            const observation = { windows, at: now, usageProviderId: row.usageProviderId, authMode: row.authMode };
            observations.set(id, observation);
            if (generation === this.#snapshotGeneration && !this.#stopped) this.#apiCache.set(id, observation);
          } else if (generation === this.#snapshotGeneration && !this.#stopped) {
            // A failed observation cannot renew an expired percentage.
            this.#apiCache.delete(id);
          }
        } catch {
          if (generation === this.#snapshotGeneration && !this.#stopped) this.#apiCache.delete(id);
        }
      }),
    );
    return observations;
  }

  lastSnapshot(): QuotaFleetSnapshot | null {
    return this.#lastSnapshot;
  }

  #buildEntry(input: {
    adapterId: string;
    usageProviderId?: string;
    accountId?: string;
    active?: boolean;
    label: string;
    installed: boolean;
    onCooldown: boolean;
    cooldownKind?: FailoverReasonKind;
    cooldownUntil?: number;
    tokens?: { inputTokens: number; outputTokens: number; costUsd: number };
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
    let windows = probeProviderWindows({
      adapterId: input.adapterId,
      accountId: input.accountId,
      onCooldown: input.onCooldown,
      cooldownKind: input.cooldownKind,
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
    if (
      onCooldown &&
      allowCooldownRefutation &&
      input.accountId &&
      this.#deps.clearRefutedCooldown &&
      api !== undefined &&
      providerApiRefutesCooldown(api.windows, api.at, input.now)
    ) {
      this.#deps.clearRefutedCooldown(input.accountId, input.adapterId);
      onCooldown = false;
      cooldownUntil = undefined;
    }
    return {
      id,
      adapterId: input.adapterId,
      accountId: input.accountId,
      ...(input.active !== undefined ? { active: input.active } : {}),
      label: input.label,
      ...(input.usageProviderId ? { usageProviderId: input.usageProviderId } : {}),
      installed: input.installed,
      onCooldown,
      ...(onCooldown && input.cooldownKind
        ? { cooldownKind: input.cooldownKind }
        : {}),
      cooldownUntil,
      windows: mergeWindows(defaultUnknownWindows(input.adapterId), windows),
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

  /** Force rebuild + live API re-probe + broadcast (UI refresh button). */
  async refresh(): Promise<QuotaFleetSnapshot> {
    const snap = await this.snapshot(Date.now(), { forceApi: true });
    if (this.#stopped || snap !== this.#lastSnapshot) return snap;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isCrashed()) {
        win.webContents.send(QUOTA_CHANNELS.changed, snap);
      }
    }
    return snap;
  }
}

let configured: QuotaService | null = null;

export function initQuotaService(deps: QuotaServiceDeps): QuotaService {
  configured?.stop();
  configured = new QuotaService(deps);
  ipcMain.removeHandler(QUOTA_CHANNELS.snapshot);
  ipcMain.removeHandler(QUOTA_CHANNELS.refresh);
  ipcMain.handle(QUOTA_CHANNELS.snapshot, async () => configured!.snapshot());
  ipcMain.handle(QUOTA_CHANNELS.refresh, async () => configured!.refresh());
  return configured;
}

export function requireQuotaService(): QuotaService {
  if (!configured) throw new Error('quota service not initialized');
  return configured;
}

export function noteQuotaLimitHit(
  adapterId: string,
  hit: LimitHit,
  accountId?: string,
): void {
  configured?.noteLimitHit(adapterId, hit, accountId);
}

export function shutdownQuotaService(): void {
  ipcMain.removeHandler(QUOTA_CHANNELS.snapshot);
  ipcMain.removeHandler(QUOTA_CHANNELS.refresh);
  configured?.stop();
  configured = null;
}
