/** Defaults de produto que devem permanecer alinhados em adapters e catálogo. */
export const CODEX_FRONTIER_MODEL = 'gpt-5.6-sol';
export const GROK_FRONTIER_MODEL = 'grok-4.7';

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
  // gemini-3.8-pro não existe no Google Gemini — o modelo correto da linhagem 3.8 é gemini-3.8-flash-high
  'gemini-3.8-pro-high': 'gemini-3.8-flash-high',
  'gemini-3.8-pro': 'gemini-3.8-flash-high',
  'gemini-3.1-pro-high': 'gemini-3.8-flash-high',
  // Muse 1.3: o id "muse" era placeholder do adapter — o CLI recusa e o
  // chip virava "Muse muse". Default real do binário 1.3.0: muse-spark-1.3.
  muse: 'muse-spark-1.3',
});

export function migrateModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  const bare = modelId.trim();
  return RETIRED_MODEL_MIGRATIONS[bare] ?? modelId;
}
