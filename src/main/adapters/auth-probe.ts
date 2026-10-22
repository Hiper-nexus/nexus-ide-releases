import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ipcMain } from 'electron';
import { PROVIDER_CHANNELS } from '../../shared/provider-settings-types';
import type { AdapterAuthStatus, AuthState } from '../../shared/provider-settings-types';
import {
  grokHasNoRenewableSession,
  listProviderSettings,
  notifyProviderAuthChanged,
  warmGrokAccountCredentialCache,
} from '../persistence/provider-config-store';
import {
  claudeOauthEmail,
  hasSubscriptionAuth,
  refreshAgySubscriptionAuthCache,
  refreshClaudeSubscriptionAuthCache,
  refreshOpenClaudeSubscriptionAuthCache,
  subscriptionAuthStatusIsUnknown,
} from './subscription-auth';
import { refreshKimiSeatReadiness } from './kimi-seat-probe';
import {
  agyWindowsUnreadableSessionReason,
  hasNativeFileAuth,
  isFileAuthAdapter,
  nativeAuthIdentity,
} from './managed-credentials';
import { invalidateAgyWindowsKeyringCache } from './agy-windows-keyring';
import {
  detailWithIdentity,
  emailFromAuthDetail,
} from '../../shared/auth-detail-identity';
import { claudeCredentialFingerprint } from './claude-credential';
import { minimaxCodeSignedInRegion, minimaxCodeUsesOwnApiKey } from './minimax-code-auth';

/**
 * Sonda de login das CLIs — SEM navegador. Cada CLI guarda a sessão OAuth
 * localmente (arquivo ou Keychain); presença do artefato = conta logada (as
 * CLIs renovam token sozinhas, então checar expiração aqui geraria alarme
 * falso). Para providers de API pura, a chave no cofre é o próprio estado.
 * Logar de novo também dispensa navegador embutido: abrir um pane com a CLI
 * dispara o fluxo dela, que abre o navegador DO SISTEMA já logado.
 *
 * A saved identity is not proof of login; unavailable credential storage is
 * unknown. Refreshes also update the cache used by provider snapshots.
 */

const HOME = os.homedir();

export interface ProbeAdapterAuthOptions {
  /**
   * O terminal da CLI acabou de imprimir sucesso. Ignore uma credencial
   * positiva/ausente cacheada antes do login; backoff de ACL negada continua
   * valendo para não reabrir o diálogo do macOS em loop.
   */
  freshClaudeCredential?: boolean;
}

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
  (options?: ProbeAdapterAuthOptions) => Promise<{
    state: AuthState;
    detail: string;
    sessionFingerprint?: string;
  }>
> = {
  claude: async (options) => {
    // Live session ≠ identity. Prefer the same detector as spawn readiness
    // (usable OAuth token / credentials file). Email alone is identity only.
    const proof = await refreshClaudeSubscriptionAuthCache(
      HOME,
      undefined,
      {
        authoritative: true,
        freshCredential: options?.freshClaudeCredential === true,
      },
    );
    if (proof.value) {
      const email = claudeOauthEmail(HOME);
      const sessionFingerprint = claudeCredentialFingerprint(proof.credential);
      return {
        state: 'ok',
        detail: email
          ? `sessão Claude viva: ${email}`
          : 'sessão Claude OAuth detectada',
        ...(sessionFingerprint ? { sessionFingerprint } : {}),
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
    return { state: 'missing', detail: 'sem sessão — rode `claude auth login`' };
  },
  codex: async () =>
    hasNativeFileAuth('codex')
      ? { state: 'ok', detail: 'sessão Codex OAuth local (auth.json)' }
      : { state: 'missing', detail: 'sem sessão — rode `codex login`' },
  agy: async () => {
    invalidateAgyWindowsKeyringCache();
    // Delegate to the shared detector (like grok/kimi) so a managed AGY account
    // under $GEMINI_CLI_HOME is recognized, not just ~/.gemini in the real home.
    if (!(await refreshAgySubscriptionAuthCache(
      HOME,
      undefined,
      { authoritative: true },
    )).value) {
      return {
        state: 'missing',
        detail: 'sem sessão — rode `agy` e conclua o OAuth',
      };
    }
    // F-1580: no Windows um arquivo que sobrou em ~/.gemini (Gemini CLI, AGY
    // antigo) não é sessão do AGY. Contado como "ok", a tela oferecia "Salvar
    // esta conta" e guardava uma conta que nunca abria; e o cadastro de outra
    // conta parava ao tentar guardar essa sobra antes do login.
    const unreadable = agyWindowsUnreadableSessionReason();
    if (unreadable) return { state: 'missing', detail: unreadable };
    return { state: 'ok', detail: 'sessão AGY local' };
  },
  grok: async () => {
    if (!hasNativeFileAuth('grok')) {
      return { state: 'missing', detail: 'sem sessão — rode `grok login`' };
    }
    // An old access token without renewal material is not a ready session.
    // Complete OIDC credentials remain eligible for CLI-owned refresh: age
    // alone is not evidence of revocation. No refresh is performed by this probe.
    if (grokHasNoRenewableSession()) {
      return {
        state: 'missing',
        detail:
          'a sessão do Grok expirou e faltam dados para renovação — use "Entrar" no ' +
          'cartão do Grok em Atenção, ou Configurações › Contas de IA',
      };
    }
    return { state: 'ok', detail: 'sessão Grok OAuth local' };
  },
  kimi: async () => {
    // File OAuth alone was the 19 Aug false positive (CLI 0.37.2 half-dead
    // after folder-trust). Only a live `kimi provider list` with source=oauth
    // (or an API key in the vault, applied below) is a seat.
    const readiness = await refreshKimiSeatReadiness();
    if (readiness === 'present') {
      return {
        state: 'ok',
        detail: 'sessão Kimi Code OAuth (provider list, source=oauth)',
      };
    }
    return {
      state: 'missing',
      detail: 'sem source=oauth em `kimi provider list` — rode `kimi login`',
    };
  },
  'mimo-code': async () =>
    hasNativeFileAuth('mimo-code')
      ? { state: 'ok', detail: 'credencial Xiaomi MiMo salva pela CLI' }
      : { state: 'missing', detail: 'entre com sua conta Xiaomi MiMo' },
  // Só o estado público (auth-state.json) e a fonte no config.yaml; o
  // auth.json com token e a chave salva pela CLI não são lidos.
  'minimax-code': async () =>
    minimaxCodeSignedInRegion()
      ? { state: 'ok', detail: 'sessão MiniMax Code local (mcode login)' }
      : minimaxCodeUsesOwnApiKey()
        ? { state: 'ok', detail: 'chave MiniMax salva na própria CLI (mcode provider)' }
        : { state: 'missing', detail: 'sem sessão — rode `mcode login --region global`' },
  opencode: async () =>
    hasNativeFileAuth('opencode')
      ? { state: 'ok', detail: 'credencial OpenCode local' }
      : {
          state: 'missing',
          detail: 'sem credencial — rode `opencode auth login`',
        },
  openclaude: async () =>
    (await refreshOpenClaudeSubscriptionAuthCache(HOME, undefined, { authoritative: true })).value
      ? { state: 'ok', detail: 'sessão nativa OpenClaude detectada' }
      : {
          state: 'missing',
          detail: 'sem sessão — rode `openclaude auth login` ou `/provider`',
        },
  muse: async () => {
    if (hasSubscriptionAuth('muse')) return { state: 'ok', detail: 'credencial Muse local detectada' };
    if (subscriptionAuthStatusIsUnknown('muse', HOME)) return {
      state: 'unknown',
      detail: 'Muse usa o Keychain; abra a CLI para verificar a sessão',
    };
    return { state: 'missing', detail: 'sem credencial Muse detectada — rode `muse login`' };
  },
  // Devin grava TOML plano em $XDG_DATA_HOME/devin/credentials.toml
  // (no Windows, %APPDATA%\devin\credentials.toml). Sem
  // seções nem campo de frescor) — o detector é o mesmo hasNativeFileAuth dos
  // outros, com ramo próprio em managed-credentials.
  devin: async () =>
    hasNativeFileAuth('devin')
      ? { state: 'ok', detail: 'sessão Devin OAuth local' }
      : { state: 'missing', detail: 'sem sessão — rode `devin auth login`' },
  aider: async () => ({
    state: 'missing',
    detail: 'Aider usa API key — cole a chave do provedor',
  }),
};

export async function probeAdapterAuth(
  options: ProbeAdapterAuthOptions = {},
): Promise<AdapterAuthStatus[]> {
  // F-1485: a sonda é assíncrona e alimenta authState, que a lista Atenção
  // exige como 'missing' para mostrar o botão "Entrar". Sem aquecer o cofre,
  // `grokHasNoRenewableSession` vê cofre frio, não estreita, e o cartão some
  // exatamente quando o operador precisa dele.
  warmGrokAccountCredentialCache();
  const infos = listProviderSettings({ nonBlockingAuth: true }).filter((p) => p.adapterId !== 'shell');
  const statuses = await Promise.all(
    infos.map(async (info): Promise<AdapterAuthStatus> => {
      const probe = OAUTH_PROBES[info.adapterId];
      if (probe) {
        const { state, detail, sessionFingerprint } = await probe(options).catch(
          () => ({
            state: 'unknown' as const,
            detail:
              'Não foi possível verificar a sessão agora. Verifique novamente.',
            sessionFingerprint: undefined,
          }),
        );
        // Chave de API no cofre cobre a CLI mesmo sem sessão OAuth.
        if (state !== 'ok' && info.hasKey) {
          return {
            adapterId: info.adapterId,
            state: 'ok',
            detail: 'API key no cofre',
          };
        }
        // A sessão nativa fornece e-mail real quando houver e sempre que
        // possível um fingerprint opaco. Assim a UI detecta A -> B inclusive
        // em CLIs sem e-mail (Kimi/OpenCode), sem receber token/subject.
        const identity =
          state === 'ok' && isFileAuthAdapter(info.adapterId)
            ? nativeAuthIdentity(info.adapterId)
            : {};
        const finalDetail =
          !emailFromAuthDetail(detail) && identity.email
            ? detailWithIdentity(detail, identity.email)
            : detail;
        return {
          adapterId: info.adapterId,
          state,
          detail: finalDetail,
          ...(identity.revision ? { sessionRevision: identity.revision } : {}),
          ...(sessionFingerprint || identity.fingerprint
            ? {
                sessionFingerprint:
                  sessionFingerprint ?? identity.fingerprint,
              }
            : {}),
        };
      }
      if (info.hasKey) {
        return { adapterId: info.adapterId, state: 'ok', detail: 'API key no cofre' };
      }
      if (!info.installed) {
        return { adapterId: info.adapterId, state: 'unknown', detail: 'CLI não instalada' };
      }
      if (info.keyEnvVar) {
        return {
          adapterId: info.adapterId,
          state: 'missing',
          detail: 'precisa colar a chave desta CLI',
        };
      }
      return {
        adapterId: info.adapterId,
        state: 'unknown',
        detail: 'sem sonda para esta CLI — abra-a para verificar',
      };
    }),
  );
  notifyProviderAuthChanged();
  return statuses;
}

export function registerAuthProbeIpc(): void {
  ipcMain.handle(PROVIDER_CHANNELS.authStatus, (_event, raw?: unknown) => {
    const freshClaudeCredential =
      Boolean(
        raw &&
          typeof raw === 'object' &&
          (raw as { freshClaudeCredential?: unknown })
            .freshClaudeCredential === true,
      );
    return probeAdapterAuth({ freshClaudeCredential });
  });
}
