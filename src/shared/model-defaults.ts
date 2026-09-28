/** Defaults de produto que devem permanecer alinhados em adapters e catálogo. */
// GPT-6 Sol é o default de trabalho (custo × qualidade); o GPT-6 Astra é o
// topo, mas custa 5× — só o tier crítico o pede (docs/models/estudo-2026-09.md).
// gpt-5.6-sol/terra/luna permanecem listados (superseded ≠ retired) e NÃO
// migram em RETIRED_MODEL_MIGRATIONS.
export const CODEX_FRONTIER_MODEL = 'gpt-6-sol';
export const GROK_FRONTIER_MODEL = 'grok-4.7';

/**
 * Modelos legados/aposentados pelos provedores que causam erro 400 se solicitados.
 * Mapeamento automático para versões ativas da mesma linhagem.
 *
 * REGRA: só ids que o provider REALMENTE removeu entram aqui. Um modelo
 * superseded porém ainda executável (ex.: claude-opus-5 frente ao 5.5) NÃO
 * migra — `resolveRoutableModel` descartaria o candidato quando o CLI ainda
 * só tem o antigo, e o picker ainda o oferece. Supersede vive na ordem das
 * listas e no routing table.
 *
 * As chaves são globais (sem adapterId): use ids inequívocos. Uma chave
 * solta como `1.6` reescreveria modelo de QUALQUER provider.
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
  // Decisão do operador (2026-09-27, docs/models/estudo-2026-09.md): 3.1 Pro
  // é pior e ~3× mais caro que o 3.8 Flash (TB2.1 70,8 × 81,3; AA 30 × 41).
  // Sai da lista OFERECIDA do agy (agy.json/model-catalog.ts) mesmo a CLI
  // ainda aceitando o id — por isso volta a migrar em silêncio.
  'gemini-3.1-pro-high': 'gemini-3.8-flash-high',
  'gemini-3.1-pro-low': 'gemini-3.8-flash-low',
  // Muse 1.3: o id "muse" era placeholder do adapter — o CLI recusa e o
  // chip virava "Muse muse". Default real do binário 1.3.0: muse-spark-1.3.
  muse: 'muse-spark-1.3',
  // xAI aposentou estes quatro (`grok models` na CLI instalada, 2026-09-27:
  // só grok-4.7/grok-4.7-build-fast/grok-4.6/grok-4.5 continuam na conta) —
  // o roteamento oferecia grok-4.1 para o operador achar "grok já é o 4.7".
  'grok-4.1': GROK_FRONTIER_MODEL,
  'grok-4': GROK_FRONTIER_MODEL,
  'grok-4-fast': GROK_FRONTIER_MODEL,
  'grok-code-fast-1': GROK_FRONTIER_MODEL,
  'grok-3': GROK_FRONTIER_MODEL,
  // `agy models` (2026-09-27) só tem as linhas 3.6/3.7/3.8 com esforço; a
  // 3.5 saiu. Chave com sufixo de esforço só existe no agy.
  'gemini-3.5-flash-low': 'gemini-3.8-flash-low',
  'gemini-3.5-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-high': 'gemini-3.8-flash-high',
  // Kimi Code 2.x só aceita os ALIASES do config.toml (`kimi-code/…`); os ids
  // da era kimi-cli continuavam na lista oferecida e o operador guardou
  // "kimi-k2.7" como padrão — o pane abria com "Model kimi-k2.7 is not
  // configured in config.toml" e nunca criava sessão (smoke 28/09). K2.7 é o
  // "K2.7 Coding" do config; o resto vai para o default k3.
  'kimi-k2.7': 'kimi-code/kimi-for-coding',
  'kimi-k2.7-code-highspeed': 'kimi-code/kimi-for-coding-highspeed',
  'kimi-k2-turbo': 'kimi-code/kimi-for-coding-highspeed',
  'kimi-k2.6': 'kimi-code/kimi-for-coding',
  'kimi-k2': 'kimi-code/kimi-for-coding',
  'kimi-k2.8': 'kimi-code/k3',
  'moonshot-v1-128k': 'kimi-code/k3',
  'moonshot-v1-32k': 'kimi-code/k3',
  // Free sem credencial que saíram de `opencode models` (2026-09-27): vão
  // para o default credentialless do adapter, nunca para um id pago.
  'opencode/deepseek-v4-flash-free': 'opencode/big-pickle',
  'opencode/mimo-v2.5-free': 'opencode/big-pickle',
  'opencode/north-mini-code-free': 'opencode/big-pickle',
  'opencode/laguna-s-2.1-free': 'opencode/big-pickle',
  'opencode/ling-3.0-flash-free': 'opencode/big-pickle',
});

export function migrateModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId;
  const bare = modelId.trim();
  return RETIRED_MODEL_MIGRATIONS[bare] ?? modelId;
}
