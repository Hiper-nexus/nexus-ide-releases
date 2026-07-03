import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  ACCOUNT_CHANNELS,
  addAccountSchema,
  accountIdSchema,
  renameAccountSchema,
} from '../../shared/account-types';
import { getDb } from './db';
import {
  activateAccount,
  addAccount,
  addActiveClaudeAccount,
  initAccountStore,
  listAccountInfos,
  onAccountsChange,
  removeAccount,
  renameAccount,
} from './account-store';
import {
  initFailover,
  registerFailoverListener,
  unregisterFailoverListener,
} from '../orch/failover';
import { z } from 'zod';

/** Renderer-facing IPC for account management + failover boot. */

const listeners = new Set<WebContents>();

function broadcast(): void {
  const snapshot = listAccountInfos();
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(ACCOUNT_CHANNELS.changed, snapshot);
  }
}

export function registerAccountListener(wc: WebContents): void {
  listeners.add(wc);
  registerFailoverListener(wc);
}
export function unregisterAccountListener(wc: WebContents): void {
  listeners.delete(wc);
  unregisterFailoverListener(wc);
}

const addActiveClaudeSchema = z.object({ label: z.string().min(1).max(128) });

export function registerAccountIpc(): void {
  initAccountStore(getDb());
  initFailover();
  onAccountsChange(broadcast);

  ipcMain.handle(ACCOUNT_CHANNELS.list, () => listAccountInfos());

  ipcMain.handle(ACCOUNT_CHANNELS.add, (_e, raw) => {
    const parsed = addAccountSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid account' };
    const account = addAccount(parsed.data);
    return { ok: true, id: account.id };
  });

  ipcMain.handle(ACCOUNT_CHANNELS.addActiveClaude, (_e, raw) => {
    const parsed = addActiveClaudeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid label' };
    const account = addActiveClaudeAccount(parsed.data.label);
    return account
      ? { ok: true, id: account.id, email: account.email }
      : {
          ok: false,
          error:
            'Nenhuma sessão Claude ativa no Keychain. Faça login (`claude` → /login) e tente de novo.',
        };
  });

  ipcMain.handle(ACCOUNT_CHANNELS.rename, (_e, raw) => {
    const parsed = renameAccountSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    renameAccount(parsed.data.id, parsed.data.label);
    return { ok: true };
  });

  ipcMain.handle(ACCOUNT_CHANNELS.remove, (_e, raw) => {
    const parsed = accountIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    removeAccount(parsed.data.id);
    return { ok: true };
  });

  ipcMain.handle(ACCOUNT_CHANNELS.activate, (_e, raw) => {
    const parsed = accountIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    return { ok: activateAccount(parsed.data.id) };
  });
}
