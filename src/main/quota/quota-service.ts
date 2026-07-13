/**
 * In-memory fleet quota service. Builds ProviderQuotaEntry[] from installed
 * adapters + vault accounts + limit/cooldown signals + live provider APIs
 * (Claude OAuth usage). Broadcasts coalesced snapshots to renderers.
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
import {
  fetchClaudeOauthUsageWindows,
  type FetchLike,
} from './claude-oauth-usage';

/** Cache live API windows briefly — avoid hammering Anthropic on every paint. */
const PROVIDER_API_TTL_MS = 60_000;

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

    const fleet = providers.length > 0 ? providers : [];

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

    // Live Claude OAuth usage for every Claude row (vault token or active CLI).
    await this.#hydrateClaudeApiWindows(draft, now, forceApi);

    const entries: ProviderQuotaEntry[] = draft.map((d) =>
      this.#buildEntry({ ...d, now }),
    );

    entries.sort((a, b) => a.label.localeCompare(b.label, 'pt'));
    const snap = buildFleetSnapshot(entries, now);
    this.#lastSnapshot = snap;
    return snap;
  }

  async #hydrateClaudeApiWindows(
    draft: ReadonlyArray<{ adapterId: string; accountId?: string }>,
    now: number,
    forceApi: boolean,
  ): Promise<void> {
    if (!this.#deps.resolveClaudeAccessToken) return;

    const claudeRows = draft.filter((d) => d.adapterId === 'claude');
    if (claudeRows.length === 0) return;

    await Promise.all(
      claudeRows.map(async (row) => {
        const id = entryId({
          adapterId: row.adapterId,
          accountId: row.accountId,
        });
        if (!forceApi) {
          const cached = this.#apiCache.get(id);
          if (cached && now - cached.at < PROVIDER_API_TTL_MS) return;
        }
        try {
          const token = await Promise.resolve(
            this.#deps.resolveClaudeAccessToken!(row.accountId),
          );
          if (!token) {
            this.#apiCache.delete(id);
            return;
          }
          const windows = await fetchClaudeOauthUsageWindows(token, {
            fetchImpl: this.#deps.fetchImpl,
            now,
          });
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
