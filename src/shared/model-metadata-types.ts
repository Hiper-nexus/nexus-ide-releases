/**
 * Contrato compartilhado (main ↔ preload ↔ renderer) do metadado rico de
 * modelo — preço USD/MTok, janela de contexto, teto de saída e capacidades.
 *
 * Fonte de verdade no main: getRichModelMetadata() em
 * src/main/adapters/model-catalog.ts, que resolve o recorte vendorado do
 * oh-my-pi (src/vendor/omp/catalog). Este arquivo só declara o SHAPE que
 * cruza o IPC read-only `model:richMetadata` — sem lógica, sem segredos.
 *
 * O shape espelha RichModelEntry + ompProvider (RichModelMetadata do main),
 * de modo que o retorno do handler é estruturalmente atribuível a
 * RichModelMetadataView sem conversão.
 */

/** Preço em USD por milhão de tokens (MTok), como no catálogo do omp. */
export interface RichModelCostView {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Metadado rico de um modelo, seguro para o renderer (nenhum segredo). */
export interface RichModelMetadataView {
  id: string;
  name?: string;
  api?: string;
  cost?: RichModelCostView;
  /** Janela de contexto em tokens (ex.: 200000). */
  contextWindow?: number;
  /** Teto de tokens de saída por resposta. */
  maxTokens?: number;
  /** Modelo de raciocínio (thinking) quando true. */
  reasoning?: boolean;
  /** Modalidades de entrada aceitas (ex.: 'text', 'image'). */
  input?: string[];
  /** Provider do catálogo omp que forneceu o metadado (ex.: 'anthropic', 'xai'). */
  ompProvider: string;
}
