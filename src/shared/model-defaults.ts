/** Defaults de produto que devem permanecer alinhados em adapters e catálogo. */
export const CODEX_FRONTIER_MODEL = 'gpt-5.6-sol';

/**
 * Modelos legados/aposentados pelos provedores que causam erro 400 se solicitados.
 * Mapeamento automático para versões ativas da mesma linhagem.
 */
export const RETIRED_MODEL_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-5.4': 'gpt-5.6-luna',
  'gpt-5.4-mini': 'gpt-5.6-luna',
  'gpt-5.4-nano': 'gpt-5.6-luna',
  'gpt-5.4-pro': 'gpt-5.6-sol',
  'gpt-5.3': 'gpt-5.6-luna',
  'gpt-5.3-codex': 'gpt-5.6-luna',
});

export function migrateModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  const bare = modelId.trim();
  return RETIRED_MODEL_MIGRATIONS[bare] ?? modelId;
}

