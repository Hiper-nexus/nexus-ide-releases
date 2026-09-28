import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * Environment variables understood by Kimi Code's explicit transient-model
 * channel. Ordinary KIMI_API_KEY/MOONSHOT_API_KEY shell variables are not
 * provider credentials in current Kimi Code releases.
 *
 * Keep this list complete so an OAuth-backed pane cannot be redirected to a
 * transient API-key provider inherited from the Nexus process.
 */
export const KIMI_TRANSIENT_MODEL_ENV_KEYS = [
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_CAPABILITIES',
  'KIMI_MODEL_DISPLAY_NAME',
  'KIMI_MODEL_MAX_OUTPUT_SIZE',
  'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_THINKING_EFFORT',
  'KIMI_MODEL_ADAPTIVE_THINKING',
  'KIMI_MODEL_MAX_COMPLETION_TOKENS',
  'KIMI_MODEL_TEMPERATURE',
  'KIMI_MODEL_TOP_P',
  'KIMI_MODEL_THINKING_KEEP',
] as const;

function directApiModelName(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error('Kimi API-key fallback requires a model name');
  }
  return normalized.startsWith('kimi-code/')
    ? normalized.slice('kimi-code/'.length)
    : normalized;
}

/**
 * Build the process-only credentials supported by current Kimi Code. The key
 * stays in the child environment; neither providers.json nor Kimi config.toml
 * is rewritten.
 */
export function buildKimiApiKeyRuntimeEnv(
  key: string,
  model: string,
): Record<string, string> {
  if (!key.trim()) {
    throw new Error('Kimi API-key fallback requires a non-empty key');
  }
  return {
    KIMI_MODEL_API_KEY: key,
    KIMI_MODEL_NAME: directApiModelName(model),
  };
}

/**
 * Aliases de modelo declarados no config.toml do Kimi Code (chaves de
 * `[models]`). `kimi --model` só aceita um destes: qualquer outro id derruba a
 * sessão inteira ("Model … is not configured in config.toml"). O parser é o
 * mesmo do overlay (smol-toml): aceita `[models."x"]`, `[models . "x"]` e a
 * forma inline. Arquivo inválido cai para a leitura por linha dos cabeçalhos.
 */
export function parseKimiConfigModelAliases(toml: string): string[] {
  try {
    const parsed = parseToml(toml) as { models?: unknown };
    if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
      return Object.keys(parsed.models as Record<string, unknown>);
    }
    return [];
  } catch {
    const aliases: string[] = [];
    for (const line of toml.split(/\r?\n/)) {
      const match = /^\s*\[models\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]\s*(?:#.*)?$/.exec(line);
      const alias = match?.[1] ?? match?.[2] ?? match?.[3];
      if (alias && !aliases.includes(alias)) aliases.push(alias);
    }
    return aliases;
  }
}

/** Diretório do Kimi Code em vigor: overlay gerenciado (KIMI_CODE_HOME) ou ~/.kimi-code. */
export function kimiCodeHome(home = os.homedir()): string {
  return process.env.KIMI_CODE_HOME?.trim() || path.join(home, '.kimi-code');
}

/**
 * Aliases do config.toml em vigor; [] quando não há config (CLI antiga ou não
 * instalada). `kimiCodeHome` é o perfil do PANE (a conta escolhida chega em
 * `keyEnv.KIMI_CODE_HOME`), não necessariamente o do Main.
 */
export function readKimiModelAliases(
  options: { readonly home?: string; readonly kimiCodeHome?: string } = {},
): string[] {
  const dir = options.kimiCodeHome?.trim() || kimiCodeHome(options.home);
  try {
    return parseKimiConfigModelAliases(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'));
  } catch {
    return [];
  }
}
