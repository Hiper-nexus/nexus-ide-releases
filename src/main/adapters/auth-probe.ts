import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ipcMain } from 'electron';
import { PROVIDER_CHANNELS } from '../../shared/provider-settings-types';
import type { AdapterAuthStatus, AuthState } from '../../shared/provider-settings-types';
import { listProviderSettings } from '../persistence/provider-config-store';
import {
  claudeOauthEmail,
  detectSubscriptionAuth,
  hasSubscriptionAuth,
} from './subscription-auth';

/**
 * Sonda de login das CLIs — SEM navegador. Cada CLI guarda a sessão OAuth
 * localmente (arquivo ou Keychain); presença do artefato = conta logada (as
 * CLIs renovam token sozinhas, então checar expiração aqui geraria alarme
 * falso). Para providers de API pura, a chave no cofre é o próprio estado.
 * Logar de novo também dispensa navegador embutido: abrir um pane com a CLI
 * dispara o fluxo dela, que abre o navegador DO SISTEMA já logado.
 *
 * Claude: MUST match `detectSubscriptionAuth` — file-backed ~/.claude.json
 * oauthAccount is authoritative when Keychain is unreadable from Electron.
 */

const HOME = os.homedir();

function fileExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Metadado no Keychain (sem ler o segredo — não dispara prompt de senha). */
function keychainHas(service: string): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service],
      { timeout: 4_000 },
      (err) => resolve(!err),
    );
  });
}

/** Sondas específicas por CLI OAuth (as demais caem em hasKey do cofre). */
const OAUTH_PROBES: Record<
  string,
  () => Promise<{ state: AuthState; detail: string }>
> = {
  claude: async () => {
    // Live session ≠ identity. Prefer the same detector as spawn readiness
    // (usable OAuth token / credentials file). Email alone is identity only.
    if (detectSubscriptionAuth('claude', HOME)) {
      const email = claudeOauthEmail(HOME);
      return {
        state: 'ok',
        detail: email
          ? `sessão Claude viva: ${email}`
          : 'sessão Claude OAuth detectada',
      };
    }
    const email = claudeOauthEmail(HOME);
    if (email) {
      return {
        state: 'missing',
        detail:
          `identidade Claude (${email}) sem sessão viva — rode \`claude auth login\``,
      };
    }
    if (fileExists(path.join(HOME, '.claude', '.credentials.json'))) {
      return {
        state: 'missing',
        detail: 'arquivo de credenciais Claude sem access token utilizável',
      };
    }
    if (await keychainHas('Claude Code-credentials')) {
      return {
        state: 'missing',
        detail:
          'item Keychain presente mas sem OAuth utilizável — rode `claude auth login`',
      };
    }
    return { state: 'missing', detail: 'sem sessão — rode a CLI e faça /login' };
  },
  codex: async () => {
    if (fileExists(path.join(HOME, '.codex', 'auth.json'))) {
      return { state: 'ok', detail: 'sessão OAuth local (auth.json)' };
    }
    return { state: 'missing', detail: 'sem sessão — rode `codex login`' };
  },
  agy: async () =>
    // Delegate to the shared detector (like grok/kimi) so a managed AGY account
    // under $GEMINI_CLI_HOME is recognized, not just ~/.gemini in the real home.
    hasSubscriptionAuth('agy')
      ? { state: 'ok', detail: 'sessão AGY local' }
      : {
          state: 'missing',
          detail: 'sem sessão — rode `agy` e conclua o OAuth',
        },
  grok: async () =>
    hasSubscriptionAuth('grok')
      ? { state: 'ok', detail: 'sessão Grok OAuth local' }
      : { state: 'missing', detail: 'sem sessão — rode `grok login`' },
  kimi: async () =>
    hasSubscriptionAuth('kimi')
      ? { state: 'ok', detail: 'sessão Kimi Code OAuth local' }
      : { state: 'missing', detail: 'sem sessão — rode `kimi login`' },
  opencode: async () =>
    hasSubscriptionAuth('opencode')
      ? { state: 'ok', detail: 'credencial OpenCode local' }
      : {
          state: 'missing',
          detail: 'sem credencial — rode `opencode auth login`',
        },
  aider: async () => ({
    state: 'missing',
    detail: 'Aider usa API key — configure uma credencial de provider',
  }),
};

export async function probeAdapterAuth(): Promise<AdapterAuthStatus[]> {
  const infos = listProviderSettings().filter((p) => p.adapterId !== 'shell');
  return Promise.all(
    infos.map(async (info): Promise<AdapterAuthStatus> => {
      const probe = OAUTH_PROBES[info.adapterId];
      if (probe) {
        const { state, detail } = await probe();
        // Chave de API no cofre cobre a CLI mesmo sem sessão OAuth.
        if (state === 'missing' && info.hasKey) {
          return {
            adapterId: info.adapterId,
            state: 'ok',
            detail: 'API key no cofre',
          };
        }
        return { adapterId: info.adapterId, state, detail };
      }
      if (info.hasKey) {
        return { adapterId: info.adapterId, state: 'ok', detail: 'API key no cofre' };
      }
      if (!info.installed) {
        return { adapterId: info.adapterId, state: 'unknown', detail: 'CLI não instalada' };
      }
      return {
        adapterId: info.adapterId,
        state: 'unknown',
        detail: 'sem sonda para esta CLI — abra-a para verificar',
      };
    }),
  );
}

export function registerAuthProbeIpc(): void {
  ipcMain.handle(PROVIDER_CHANNELS.authStatus, () => probeAdapterAuth());
}
