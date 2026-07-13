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
  #snapshotInFlight: Promise<QuotaFleetSnapshot> | null = null;

  constructor(deps: QuotaServiceDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;
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
      return this.#snapshotInFlight;
    }
    const run = this.#buildSnapshot(now, opts?.forceApi === true);
    this.#snapshotInFlight = run;
    try {
      return await run;
    } finally {
      if (this.#snapshotInFlight === run) this.#snapshotInFlight = null;
    }
  }

  async #buildSnapshot(
    now: number,
    forceApi: boolean,
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
      accountId?: string;
      label: string;
      installed: boolean;
      onCooldown: boolean;
      cooldownUntil?: number;
      tokens?: { inputTokens: number; outputTokens: number; costUsd: number };
    }> = [];

    // Only CLIs the user actually has reason to care about:
    // enabled + (installed on PATH, vault account, or local token spend).
    // Never invent rows for unused adapters (e.g. OpenCode never installed).
    const fleet = providers.filter((p) => {
      if (p.enabled === false) return false;
      if (p.installed) return true;
      if (accounts.some((a) => a.adapterId === p.adapterId)) return true;
      const tok = tokens[p.adapterId];
      if (tok && tok.inputTokens + tok.outputTokens > 0) return true;
      return false;
    });

    for (const p of fleet) {
      const vault = accounts.filter((a) => a.adapterId === p.adapterId);
      if (vault.length === 0) {
        draft.push({
          adapterId: p.adapterId,
          label: p.label,
          installed: p.installed,
          onCooldown: false,
          tokens: tokens[p.adapterId],
        });
        continue;
      }
      // Bare system/CLI row so native login still shows % next to vault rows.
      draft.push({
        adapterId: p.adapterId,
        label: `${p.label} · CLI nativo`,
        installed: p.installed,
        onCooldown: false,
        tokens: tokens[p.adapterId],
      });
      for (const a of vault) {
        draft.push({
          adapterId: p.adapterId,
          accountId: a.id,
          label: `${p.label} · ${a.label}`,
          installed: p.installed,
          onCooldown: a.onCooldown,
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
        label: `${p?.label ?? a.adapterId} · ${a.label}`,
        installed: p?.installed ?? false,
        onCooldown: a.onCooldown,
        cooldownUntil: a.cooldownUntil,
        tokens: tokens[a.adapterId],
      });
    }

    // Live provider APIs for every supported row (vault / keychain / launcher).
    await this.#hydrateLiveApiWindows(draft, now, forceApi);

    const entries: ProviderQuotaEntry[] = draft.map((d) =>
      this.#buildEntry({ ...d, now }),
    );

    entries.sort((a, b) => a.label.localeCompare(b.label, 'pt'));
    const snap = buildFleetSnapshot(entries, now);
    this.#lastSnapshot = snap;
    return snap;
  }

  #liveResolvers(): LiveUsageAuthResolvers {
    return {
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
    draft: ReadonlyArray<{ adapterId: string; accountId?: string }>,
    now: number,
    forceApi: boolean,
  ): Promise<void> {
    const rows =
      LIVE_PROBE_ADAPTERS === 'all'
        ? [...draft]
        : draft.filter((d) =>
            (LIVE_PROBE_ADAPTERS as ReadonlySet<string>).has(d.adapterId),
          );
    if (rows.length === 0) return;

    const resolvers = this.#liveResolvers();
    await Promise.all(
      rows.map(async (row) => {
        const id = entryId({
          adapterId: row.adapterId,
          accountId: row.accountId,
        });
        if (!forceApi) {
          const cached = this.#apiCache.get(id);
          if (cached && now - cached.at < PROVIDER_API_TTL_MS) return;
        }
        try {
          const windows = await fetchLiveProviderWindows(
            row.adapterId,
            row.accountId,
            resolvers,
            now,
          );
          if (windows && windows.length > 0) {
            this.#apiCache.set(id, { windows, at: now });
          } else if (forceApi) {
            // Force refresh failed — drop stale so UI does not show old %.
            this.#apiCache.delete(id);
          }
        } catch {
          if (forceApi) this.#apiCache.delete(id);
        }
      }),
    );
  }

  lastSnapshot(): QuotaFleetSnapshot | null {
    return this.#lastSnapshot;
  }

  #buildEntry(input: {
    adapterId: string;
    accountId?: string;
    label: string;
    installed: boolean;
    onCooldown: boolean;
    cooldownUntil?: number;
    tokens?: { inputTokens: number; outputTokens: number; costUsd: number };
    now: number;
  }): ProviderQuotaEntry {
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
      cooldownUntil: input.cooldownUntil,
      localTokens: input.tokens,
      lastLimitHit: recorded?.hit ?? null,
      lastLimitHitAt: recorded?.at,
      now: input.now,
    });
    const api = this.#apiCache.get(id);
    if (api?.windows.length) {
      windows = mergeWindows(windows, api.windows);
    }
    if (windows.length === 0) {
      windows = defaultUnknownWindows(input.adapterId);
    }
    return {
      id,
      adapterId: input.adapterId,
      accountId: input.accountId,
      label: input.label,
      installed: input.installed,
      onCooldown: input.onCooldown,
      cooldownUntil: input.cooldownUntil,
      windows: mergeWindows(defaultUnknownWindows(input.adapterId), windows),
      updatedAt: input.now,
    };
  }

  #scheduleBroadcast(): void {
    if (this.#broadcastTimer || this.#stopped) return;
    this.#broadcastTimer = setTimeout(() => {
      this.#broadcastTimer = null;
      void this.snapshot().then((snap) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && !win.webContents.isCrashed()) {
            win.webContents.send(QUOTA_CHANNELS.changed, snap);
          }
        }
      });
    }, 750);
    this.#broadcastTimer.unref?.();
  }

  /** Force rebuild + live API re-probe + broadcast (UI refresh button). */
  async refresh(): Promise<QuotaFleetSnapshot> {
    const snap = await this.snapshot(Date.now(), { forceApi: true });
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
