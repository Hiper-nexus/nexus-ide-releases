import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AdapterAuthStatus, AuthState } from '../../shared/provider-settings-types';
import { listProviderSettings } from '../persistence/provider-config-store';

/**
 * Sonda de login das CLIs — SEM navegador. Cada CLI guarda a sessão OAuth
 * localmente (arquivo ou Keychain); presença do artefato = conta logada (as
 * CLIs renovam token sozinhas, então checar expiração aqui geraria alarme
 * falso). Para providers de API pura, a chave no cofre é o próprio estado.
 * Logar de novo também dispensa navegador embutido: abrir um pane com a CLI
 * dispara o fluxo dela, que abre o navegador DO SISTEMA já logado.
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
    if (await keychainHas('Claude Code-credentials')) {
      return { state: 'ok', detail: 'sessão OAuth no Keychain' };
    }
    if (fileExists(path.join(HOME, '.claude', '.credentials.json'))) {
      return { state: 'ok', detail: 'sessão OAuth local' };
    }
    return { state: 'missing', detail: 'sem sessão — rode a CLI e faça /login' };
  },
  codex: async () => {
    if (fileExists(path.join(HOME, '.codex', 'auth.json'))) {
      return { state: 'ok', detail: 'sessão OAuth local (auth.json)' };
    }
    return { state: 'missing', detail: 'sem sessão — rode `codex login`' };
  },
  gemini: async () => {
    if (fileExists(path.join(HOME, '.gemini', 'oauth_creds.json'))) {
      return { state: 'ok', detail: 'sessão OAuth local (oauth_creds.json)' };
    }
    return { state: 'missing', detail: 'sem sessão — abra a CLI para logar' };
  },
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
