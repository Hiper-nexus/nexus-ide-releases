import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Sessão do MiniMax Code (`mcode login`, @minimax-ai/code 0.5.x).
 *
 * A CLI separa o segredo do estado: `auth.json` guarda access/refresh token e
 * `auth-state.json` guarda só status/região/expiração — a própria CLI recusa
 * gravar campo sensível ali. Login e roteamento leem SOMENTE o estado
 * público. Expiração do access não é logout: a CLI renova sozinha, então o
 * status `authenticated` é a prova.
 *
 * Única exceção (decisão do operador, 2026-09-27): a cota do plano lê o
 * access token vigente para o mesmo GET de cota que a CLI faz. Só leitura e
 * só em memória: o Nexus nunca renova (o refresh é da CLI), nunca grava e
 * nunca registra o token.
 *
 * Layout: `<data>/auth/prod/<região>/mcode-public/auth-state.json`, com
 * `<data>` = `$MINIMAX_DATA_DIR` (alias legado `MAVIS_DATA_DIR`) ou
 * `~/.minimax`; região `en` (global) ou `cn` (China).
 */
const REGIONS = ['en', 'cn'] as const;

export type MinimaxCodeRegion = (typeof REGIONS)[number];

export function minimaxCodeDataDir(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of ['MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR']) {
    const value = env[key]?.trim();
    if (value && path.isAbsolute(value)) return value;
  }
  return path.join(home, '.minimax');
}

export function minimaxCodeAuthStateFiles(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const root = path.join(minimaxCodeDataDir(home, env), 'auth', 'prod');
  return REGIONS.map((region) =>
    path.join(root, region, 'mcode-public', 'auth-state.json'),
  );
}

/**
 * `mcode provider set-minimax-key` troca a fonte para a chave própria da CLI:
 * grava `minimaxModelSource: minimax_api_key` no config.yaml. Só a linha da
 * fonte é lida — a chave fica onde a CLI a guardou.
 */
export function minimaxCodeUsesOwnApiKey(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const config = fs.readFileSync(
      path.join(minimaxCodeDataDir(home, env), 'config.yaml'),
      'utf8',
    );
    return /^minimaxModelSource:\s*["']?minimax_api_key["']?\s*(?:#.*)?$/m.test(config);
  } catch {
    return false;
  }
}

/** Região com sessão autenticada, ou null. Nunca abre o arquivo com token. */
export function minimaxCodeSignedInRegion(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): MinimaxCodeRegion | null {
  const files = minimaxCodeAuthStateFiles(home, env);
  for (let index = 0; index < files.length; index += 1) {
    try {
      const state = JSON.parse(fs.readFileSync(files[index], 'utf8')) as {
        status?: unknown;
      } | null;
      if (state?.status === 'authenticated') return REGIONS[index];
    } catch {
      // Ausente ou ilegível: sem sessão nessa região.
    }
  }
  return null;
}

/**
 * Access token vigente do `mcode login`, para a cota do plano. Vencido ou
 * ausente = null: renovar é da CLI (renovar aqui giraria o refresh dela).
 */
export function minimaxCodeLoginAccessToken(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): { accessToken: string; region: MinimaxCodeRegion } | null {
  const region = minimaxCodeSignedInRegion(home, env);
  if (!region) return null;
  try {
    const file = path.join(
      minimaxCodeDataDir(home, env), 'auth', 'prod', region, 'mcode-public', 'auth.json',
    );
    const records = (JSON.parse(fs.readFileSync(file, 'utf8')) as {
      records?: Record<string, { accessToken?: unknown; expiresAtMs?: unknown }>;
    } | null)?.records;
    for (const [key, record] of Object.entries(records ?? {})) {
      if (!key.startsWith('com.minimax.mcode.oauth.')) continue;
      const token = typeof record?.accessToken === 'string' ? record.accessToken.trim() : '';
      const expiresAt = typeof record?.expiresAtMs === 'number' ? record.expiresAtMs : 0;
      if (token && expiresAt > now) return { accessToken: token, region };
    }
  } catch {
    // Ausente ou ilegível: sem token de cota.
  }
  return null;
}

/** A CLI tem credencial própria: sessão OAuth (Token Plan) ou chave salva nela. */
export function minimaxCodeHasCredential(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return minimaxCodeSignedInRegion(home, env) !== null ||
    minimaxCodeUsesOwnApiKey(home, env);
}
