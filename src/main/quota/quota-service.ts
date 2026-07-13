/**
 * In-memory fleet quota service. Builds ProviderQuotaEntry[] from installed
 * adapters + vault accounts + limit/cooldown signals. Broadcasts coalesced
 * snapshots to renderers. O(accounts), not O(panes).
 */

import { BrowserWindow, ipcMain } from 'electron';
import {
  QUOTA_CHANNELS,
  type ProviderQuotaEntry,
  type QuotaFleetSnapshot,
} from '../../shared/quota-types';
import type { LimitHit } from '../orch/limit-detector';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { buildFleetSnapshot } from './quota-policy';
import { defaultUnknownWindows, mergeWindows } from './quota-normalize';
import { probeProviderWindows } from './quota-probes';

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
}

interface EntryKey {
  adapterId: string;
  accountId?: string;
}

function entryId(k: EntryKey): string {
  return k.accountId ? `${k.adapterId}:${k.accountId}` : k.adapterId;
}

export class QuotaService {
  readonly #deps: QuotaServiceDeps;
  readonly #limitByKey = new Map<string, LimitHit>();
  #broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSnapshot: QuotaFleetSnapshot | null = null;
  #stopped = false;

  constructor(deps: QuotaServiceDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#broadcastTimer) {
      clearTimeout(this.#broadcastTimer);
      this.#broadcastTimer = null;
    }
  }

  /** Record a limit hit for adapter/account (from failover path). */
  noteLimitHit(
    adapterId: string,
    hit: LimitHit,
    accountId?: string,
  ): void {
    if (this.#stopped) return;
    const id = entryId({ adapterId, accountId });
    this.#limitByKey.set(id, hit);
    this.#scheduleBroadcast();
  }

  async snapshot(now = Date.now()): Promise<QuotaFleetSnapshot> {
    const [providers, accounts] = await Promise.all([
      Promise.resolve(this.#deps.listProviders()),
      Promise.resolve(this.#deps.listAccounts()),
    ]);
    const tokens = this.#deps.tokensByAdapter
      ? await Promise.resolve(this.#deps.tokensByAdapter())
      : {};

    const entries: ProviderQuotaEntry[] = [];
    const installed = providers.filter((p) => p.installed || p.enabled);

    for (const p of installed) {
      const vault = accounts.filter((a) => a.adapterId === p.adapterId);
      if (vault.length === 0) {
        entries.push(
          this.#buildEntry({
            adapterId: p.adapterId,
            label: p.label,
            installed: p.installed,
            onCooldown: false,
            tokens: tokens[p.adapterId],
            now,
          }),
        );
        continue;
      }
      for (const a of vault) {
        entries.push(
          this.#buildEntry({
            adapterId: p.adapterId,
            accountId: a.id,
            label: `${p.label} · ${a.label}`,
            installed: p.installed,
            onCooldown: a.onCooldown,
            cooldownUntil: a.cooldownUntil,
            tokens: tokens[p.adapterId],
            now,
          }),
        );
      }
    }

    // Include non-installed only if they have vault accounts (user still cares).
    for (const a of accounts) {
      if (entries.some((e) => e.accountId === a.id)) continue;
      const p = providers.find((x) => x.adapterId === a.adapterId);
      entries.push(
        this.#buildEntry({
          adapterId: a.adapterId,
          accountId: a.id,
          label: `${p?.label ?? a.adapterId} · ${a.label}`,
          installed: p?.installed ?? false,
          onCooldown: a.onCooldown,
          cooldownUntil: a.cooldownUntil,
          tokens: tokens[a.adapterId],
          now,
        }),
      );
    }

    entries.sort((a, b) => a.label.localeCompare(b.label, 'pt'));
    const snap = buildFleetSnapshot(entries, now);
    this.#lastSnapshot = snap;
    return snap;
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
    const hit = this.#limitByKey.get(id) ?? this.#limitByKey.get(input.adapterId);
    // probeProviderWindows already merges limit-hit + cooldown; no second apply.
    let windows = probeProviderWindows({
      adapterId: input.adapterId,
      accountId: input.accountId,
      onCooldown: input.onCooldown,
      cooldownUntil: input.cooldownUntil,
      localTokens: input.tokens,
      lastLimitHit: hit ?? null,
      now: input.now,
    });
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

  /** Force rebuild + broadcast (UI refresh button). */
  async refresh(): Promise<QuotaFleetSnapshot> {
    const snap = await this.snapshot();
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
