import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { handleTrusted } from '../security/trusted-ipc';
import {
  ACCOUNT_CHANNELS,
  addAccountSchema,
  addActiveSessionSchema,
  accountIdSchema,
  renameAccountSchema,
  type AccountActivatedEvent,
} from '../../shared/account-types';
import { getDb } from './db';
import {
  activateAccount,
  addAccount,
  addActiveSessionAccountAuthoritative,
  getAccount,
  initAccountStore,
  listAccountInfos,
  onAccountsChange,
  prepareAgyNativeLogin,
  prepareCodexNativeLogin,
  removeAccount,
  renameAccount,
  restoreAgyNativeLogin,
  restoreCodexNativeLogin,
  supportsSessionSnapshot,
} from './account-store';
import { listAccountQuota } from './account-quota';
import {
  initFailover,
  registerFailoverListener,
  resetInstantAuthDeaths,
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

function broadcastActivated(event: AccountActivatedEvent): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(ACCOUNT_CHANNELS.activated, event);
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
  ipcMain.handle(ACCOUNT_CHANNELS.quota, () => listAccountQuota());

  ipcMain.handle(ACCOUNT_CHANNELS.supportsSnapshot, (_e, raw) => {
    const parsed = z.object({ adapterId: z.string().min(1).max(64) }).safeParse(raw);
    if (!parsed.success) return { ok: false, supported: false };
    return { ok: true, supported: supportsSessionSnapshot(parsed.data.adapterId) };
  });

  handleTrusted(ACCOUNT_CHANNELS.prepareAgyLogin, () => prepareAgyNativeLogin());
  handleTrusted(ACCOUNT_CHANNELS.restoreAgyLogin, () => ({
    ok: restoreAgyNativeLogin(),
  }));
  // O `codex login` revoga o login que encontra no auth.json: a vaga nativa
  // sai vazia (e volta se o login não concluir) para a conta salva não morrer.
  // O renderer chama a devolução em todo desfecho; só falha real vira `ok:false`.
  handleTrusted(ACCOUNT_CHANNELS.prepareCodexLogin, () => prepareCodexNativeLogin());
  handleTrusted(ACCOUNT_CHANNELS.restoreCodexLogin, () => ({
    ok: restoreCodexNativeLogin() !== 'failed',
  }));

  handleTrusted(ACCOUNT_CHANNELS.add, (_e, raw) => {
    const parsed = addAccountSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid account' };
    try {
      const account = addAccount(parsed.data);
      return { ok: true, id: account.id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to add account',
      };
    }
  });

  handleTrusted(ACCOUNT_CHANNELS.addActiveClaude, async (_e, raw) => {
    const parsed = addActiveClaudeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid label' };
    try {
      const account = await addActiveSessionAccountAuthoritative('claude', parsed.data.label);
      if (account) resetInstantAuthDeaths(account.adapterId);
      return account
        ? { ok: true, id: account.id, email: account.email }
        : {
            ok: false,
            error:
              'Nenhuma sessão Claude ativa no Keychain. Rode `claude auth login` e tente de novo.',
          };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to snapshot Claude session',
      };
    }
  });

  handleTrusted(ACCOUNT_CHANNELS.addActiveSession, async (_e, raw) => {
    const parsed = addActiveSessionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    if (!supportsSessionSnapshot(parsed.data.adapterId)) {
      return {
        ok: false,
        error: `Provider "${parsed.data.adapterId}" não suporta snapshot de sessão OAuth.`,
      };
    }
    try {
      const account = await addActiveSessionAccountAuthoritative(
        parsed.data.adapterId,
        parsed.data.label,
        parsed.data.accountId,
      );
      if (!account) {
        const hints: Record<string, string> = {
          claude: 'Rode `claude auth login` e tente de novo.',
          codex: 'Rode `codex login` no terminal e tente de novo.',
          grok: 'Rode `grok login` no terminal e tente de novo.',
          kimi: 'Rode `kimi login` no terminal e tente de novo.',
          opencode: 'Rode `opencode auth login` e tente de novo.',
          agy: 'Rode `agy` e conclua o OAuth, depois tente de novo.',
        };
        return {
          ok: false,
          error:
            hints[parsed.data.adapterId] ??
            'Nenhuma sessão ativa detectada para este provider.',
        };
      }
      // Blob fresco do CLI vivo: as mortes instantâneas antigas não valem
      // contra a credencial nova (ver resetInstantAuthDeaths).
      resetInstantAuthDeaths(account.adapterId);
      broadcastActivated({
        accountId: account.id,
        adapterId: account.adapterId,
        label: account.label,
        needsRestart: true,
      });
      return { ok: true, id: account.id, email: account.email };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to snapshot session',
      };
    }
  });

  handleTrusted(ACCOUNT_CHANNELS.rename, (_e, raw) => {
    const parsed = renameAccountSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    renameAccount(parsed.data.id, parsed.data.label);
    return { ok: true };
  });

  handleTrusted(ACCOUNT_CHANNELS.remove, (_e, raw) => {
    const parsed = accountIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    try {
      removeAccount(parsed.data.id);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to remove account',
      };
    }
  });

  handleTrusted(ACCOUNT_CHANNELS.activate, (_e, raw) => {
    const parsed = accountIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const ok = activateAccount(parsed.data.id);
    if (!ok) {
      return {
        ok: false,
        error:
          'Não consegui sincronizar a credencial dessa conta. Salve a sessão logada novamente.',
      };
    }
    const account = getAccount(parsed.data.id);
    if (account) {
      broadcastActivated({
        accountId: account.id,
        adapterId: account.adapterId,
        label: account.label,
        needsRestart: true,
      });
    }
    return { ok: true, needsRestart: true };
  });
}
