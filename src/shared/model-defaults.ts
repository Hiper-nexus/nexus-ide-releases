/** Defaults de produto que devem permanecer alinhados em adapters e catálogo. */
export const CODEX_FRONTIER_MODEL = 'gpt-5.6-sol';

/**
 * Modelos legados/aposentados pelos provedores que causam erro 400 se solicitados.
 * Mapeamento automático para versões ativas da mesma linhagem.
 */
export const RETIRED_MODEL_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-5.5': 'gpt-5.6-luna',
  'gpt-5.4': 'gpt-5.6-luna',
  'gpt-5.4-mini': 'gpt-5.6-luna',
  'gpt-5.4-nano': 'gpt-5.6-luna',
  'gpt-5.4-pro': 'gpt-5.6-sol',
  'gpt-5.3': 'gpt-5.6-luna',
  'gpt-5.3-codex': 'gpt-5.6-luna',
  // Depreciação de produto (2026-09-14), não erro 400: o Gemini 3.1 Pro foi
  // superado pela linhagem 3.8 e o dono do produto quer todo pane/squad agy
  // sempre no modelo mais recente. Migra no spawn para não deixar pane
  // persistido preso na geração antiga.
  'gemini-3.1-pro-high': 'gemini-3.8-pro-high',
});

export function migrateModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  const bare = modelId.trim();
  return RETIRED_MODEL_MIGRATIONS[bare] ?? modelId;
}
