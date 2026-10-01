/**
 * Leitor somente-leitura do `~/.qwen/settings.json` (F-238).
 *
 * O Qwen Code não tem `qwen auth`: a credencial e o catálogo de modelos vivem
 * no settings do operador (`env.BAILIAN_TOKEN_PLAN_API_KEY`,
 * `modelProviders.openai[].id`, `model.baseUrl`). Este módulo nunca devolve o
 * valor da chave — só presença, baseUrl e ids de modelo. O spawn deixa a
 * própria CLI ler o settings; o overlay F-566 liga o arquivo sem copiá-lo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_ID_PATTERN } from '../../shared/model-id';

export interface QwenSettingsSummary {
  /** Alguma credencial utilizável presente no settings (`env.*` ou envKey). */
  readonly hasCredential: boolean;
  /** `model.baseUrl` — endpoint OpenAI-compatible configurado. */
  readonly baseUrl: string | null;
  /** Ids `qwen*` do catálogo `modelProviders.*[]` (outros providers não entram). */
  readonly modelIds: readonly string[];
}

const QWEN_MODEL_ID = /^qwen[0-9a-z.-]*$/i;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function qwenSettingsPath(home: string = os.homedir()): string {
  return path.join(process.env.QWEN_HOME ?? path.join(home, '.qwen'), 'settings.json');
}

export function readQwenSettingsSummary(
  home: string = os.homedir(),
): QwenSettingsSummary {
  const empty: QwenSettingsSummary = {
    hasCredential: false,
    baseUrl: null,
    modelIds: [],
  };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(qwenSettingsPath(home), 'utf8'));
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const settings = raw as Record<string, unknown>;

  const env = settings.env;
  let hasCredential = false;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (nonEmptyString(value)) {
        hasCredential = true;
        break;
      }
    }
  }

  const modelIds = new Set<string>();
  const providers = settings.modelProviders;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const rows of Object.values(providers as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const entry = row as Record<string, unknown>;
        const id = nonEmptyString(entry.id);
        // `envKey` aponta para uma variável de ambiente com a chave daquele
        // modelo — presença no env processo também conta como credencial.
        const envKey = nonEmptyString(entry.envKey);
        if (
          !hasCredential &&
          envKey &&
          nonEmptyString(process.env[envKey])
        ) {
          hasCredential = true;
        }
        if (
          id &&
          QWEN_MODEL_ID.test(id) &&
          MODEL_ID_PATTERN.test(id)
        ) {
          modelIds.add(id);
        }
      }
    }
  }

  const model = settings.model;
  const baseUrl =
    model && typeof model === 'object' && !Array.isArray(model)
      ? nonEmptyString((model as Record<string, unknown>).baseUrl)
      : null;

  return { hasCredential, baseUrl, modelIds: [...modelIds] };
}

/** Prontidão: a chave em settings conta como `present` — nunca lida p/ fora. */
export function qwenSettingsHasCredential(home: string = os.homedir()): boolean {
  return readQwenSettingsSummary(home).hasCredential;
}
