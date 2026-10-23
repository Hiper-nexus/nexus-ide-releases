/**
 * Model pricing table + pure cost/token estimation helpers.
 *
 * Prices are USD per MILLION tokens (input/output), matched by model-id
 * prefix after stripping any provider namespace ("moonshot/kimi-k2" → matches
 * "kimi"). The longest matching prefix wins, so "gemini-flash" beats "gemini".
 * Values are ballpark public list prices — the tracker is an estimator, not a
 * billing system.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** Optional USD per 1M cache read tokens. If omitted, uses standard provider ratio. */
  cacheReadPerM?: number;
  /** Optional USD per 1M cache write (5m) tokens. If omitted, uses standard ratio. */
  cacheWritePerM?: number;
}

/** Fallback when no prefix matches (mid-tier assistant pricing). */
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 3, outputPerM: 15 };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // === Anthropic Claude (anthropic.com/pricing & models-rich.json) ===
  // Claude Fable 5.x / Mythos 5.x (frontier generation: $10/M in, $50/M out)
  'claude-fable-5-1': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  'claude-fable-5': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  'claude-fable': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  'claude-mythos-5-1': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  'claude-mythos-5': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  'claude-mythos': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },

  // Claude Opus family (Opus 5.5/5 & 4.x: $5/M in, $25/M out; Opus 3 legacy: $15/M in, $75/M out)
  // Opus 5.5: $4/$20 (anthropic.com/claude-opus-5-5, 2026-09-22; `devin models list` 2026-09-27).
  'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWritePerM: 5 },
  'claude-opus-5': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-opus-4-6': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-opus-4-5': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-opus-4': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'claude-3-opus': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  'claude-opus': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },

  // Claude Sonnet family (Sonnet 5: $2/M in, $10/M out; Sonnet 3.5/3.7: $3/M in, $15/M out)
  // Sonnet 5.5: registry + tier_2_10 in Claude Code 2.1.284 (2026-09-28).
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  'claude-3-7-sonnet': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-3-5-sonnet': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-sonnet': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },

  // Claude Haiku family
  // Haiku 5.5: $0.10/$0.50 até 100K tokens de prompt; acima de 100K sobe para
  // $0.50/$2.50 (anthropic.com/claude/haiku, 2026-10-07). Aqui fica a faixa
  // base — prompts longos saem subestimados. O cache ($0.01 leitura, $0.125
  // escrita) veio de cobertura de imprensa, não da página oficial: confirmar.
  'claude-haiku-5-5': { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 },
  'claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4.0, cacheReadPerM: 0.08, cacheWritePerM: 1.0 },
  'claude-haiku-4-5': { inputPerM: 1.0, outputPerM: 5.0, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  'claude-3-haiku': { inputPerM: 0.25, outputPerM: 1.25, cacheReadPerM: 0.03, cacheWritePerM: 0.3 },
  'claude-haiku': { inputPerM: 1.0, outputPerM: 5.0, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  claude: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },

  // Short aliases (e.g. OpenClaude / direct flags)
  sonnet: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  opus: { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  haiku: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },

  // === OpenAI / Codex (openai.com/api/pricing & models-rich.json) ===
  // F-913: gpt-5.6-sol $5/$30 confirmados pela fonte oficial — anúncio GPT-5.6
  // da OpenAI (https://openai.com/index/gpt-5-6/, consultado em 2026-10-04):
  // "Sol is $5 input / $30 output" por 1M tokens. O conflito histórico do
  // estudo 2026-09 se explica: $4/$20 era leitura do corte temporário da nota
  // de 21/08/2026 (">20% por 3 meses", sem valor exato publicado — mantemos o
  // preço de lista), e $1,20/$6 (Devin) é o preço da luna pós-corte de
  // 30/07/2026, não do sol.
  'gpt-6-astra': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  'gpt-6': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  'gpt-6.1-sol': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 },
  'gpt-6-sol': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  'gpt-6-luna': { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  'gpt-5.6-sol': { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  'gpt-5.6-terra': { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  'gpt-5.6-luna': { inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02 },
  'gpt-5.6': { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
  'gpt-5.4-mini': { inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
  'gpt-5.4-nano': { inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
  'gpt-5.4': { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
  // gpt-5.5: modelo descontinuado; mantido para custo histórico.
  'gpt-5.5': { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  'gpt-5.2-pro': { inputPerM: 21, outputPerM: 168, cacheReadPerM: 0 },
  'gpt-5.2': { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  'gpt-5.1': { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  'gpt-5-pro': { inputPerM: 15, outputPerM: 120, cacheReadPerM: 0 },
  'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  'gpt-5-nano': { inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
  'gpt-5': { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  'o1-mini': { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.55 },
  o1: { inputPerM: 15, outputPerM: 60, cacheReadPerM: 7.5 },
  'o3-mini': { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.55 },
  o3: { inputPerM: 10, outputPerM: 40, cacheReadPerM: 5.0 },
  'o4-mini': { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.55 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6, cacheReadPerM: 0.1 },
  'gpt-4.1-nano': { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 },
  'gpt-4.1': { inputPerM: 2.0, outputPerM: 8.0, cacheReadPerM: 0.5 },
  'gpt-4-turbo': { inputPerM: 10, outputPerM: 30, cacheReadPerM: 0 },
  'gpt-4': { inputPerM: 30, outputPerM: 60, cacheReadPerM: 0 },
  'codex-mini': { inputPerM: 1.5, outputPerM: 6, cacheReadPerM: 0.375 },
  codex: { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },

  // === Google Gemini / AGY (ai.google.dev/pricing) ===
  // F-774: Gemini 4 Argon (Google, 30/09). Preço ESTIMADO [I] — inferido do
  // anúncio + comentário do catálogo; aguardando a tabela pública da Google
  // Cloud (estudo 03/10, docs/analysis/2026-10-03-missao-terminais).
  'gemini-4-argon': { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.2 },
  'gemini-3.8-pro': { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.2 },
  // 3.8 Flash: $0,75/$3,75 introdutório até 2026-12-31, depois $1,50/$7,50
  // (ai.google.dev, 2026-09-23). 3.1 Pro: $2/$12 até 200k (model card + Devin).
  'gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  'gemini-3.7-flash': { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  'gemini-3.6-flash': { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  'gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  'gemini-3.1-pro': { inputPerM: 2.0, outputPerM: 12.0, cacheReadPerM: 0.2 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0, cacheReadPerM: 0.125 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.01 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  'gemini-2.0-flash-lite': { inputPerM: 0.075, outputPerM: 0.3 },
  'gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 },
  'gemini-1.5-pro': { inputPerM: 1.25, outputPerM: 5.0, cacheReadPerM: 0.3125 },
  'gemini-1.5-flash-8b': { inputPerM: 0.0375, outputPerM: 0.15, cacheReadPerM: 0.01 },
  'gemini-1.5-flash': { inputPerM: 0.075, outputPerM: 0.3, cacheReadPerM: 0.01875 },
  'gemini-flash': { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  gemini: { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  gemma: { inputPerM: 0, outputPerM: 0 },

  // === Kimi / Moonshot AI (kimi.com & api.moonshot.cn/pricing) ===
  // K3: $3/$15 (morphllm 2026 + `devin models list` 2026-09-27).
  // K3.1 Pro: a Moonshot não publicou preço no lançamento (23/10); estimativa
  // = K3. O highspeed gasta 2× a cota do Pro (doc do Kimi Code) → 2×.
  'kimi-code/k3.1-pro-highspeed': { inputPerM: 6, outputPerM: 30, cacheReadPerM: 0.6 },
  'kimi-code/k3.1-pro': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'kimi-k3.1-pro-highspeed': { inputPerM: 6, outputPerM: 30, cacheReadPerM: 0.6 },
  'kimi-k3.1-pro': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'kimi-code/k3': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  // F-774: aliases K2.7 do config.toml do Kimi Code (api.moonshot.cn, 08/2026)
  // — sem chave própria caíam no prefixo `kimi-code` ($0,60/$2,50). A
  // variante highspeed é 2x o preço base.
  'kimi-code/kimi-for-coding-highspeed': { inputPerM: 1.9, outputPerM: 8.0, cacheReadPerM: 0.38 },
  'kimi-code/kimi-for-coding': { inputPerM: 0.95, outputPerM: 4.0, cacheReadPerM: 0.19 },
  'kimi-k3': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  k3: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  'kimi-k2.8': { inputPerM: 0.95, outputPerM: 4.0, cacheReadPerM: 0.19 },
  'kimi-k2.7-code-highspeed': { inputPerM: 1.9, outputPerM: 8.0, cacheReadPerM: 0.38 },
  'kimi-k2.7': { inputPerM: 0.95, outputPerM: 4.0, cacheReadPerM: 0.19 },
  'kimi-k2.6': { inputPerM: 0.95, outputPerM: 4.0, cacheReadPerM: 0.16 },
  'kimi-k2.5': { inputPerM: 0.6, outputPerM: 3.0, cacheReadPerM: 0.1 },
  'kimi-k2-turbo': { inputPerM: 2.4, outputPerM: 10.0, cacheReadPerM: 0.6 },
  'kimi-k2': { inputPerM: 0.6, outputPerM: 2.5, cacheReadPerM: 0.15 },
  'kimi-code': { inputPerM: 0.6, outputPerM: 2.5, cacheReadPerM: 0.15 },
  kimi: { inputPerM: 0.6, outputPerM: 2.5, cacheReadPerM: 0.15 },
  'moonshot-v1-128k': { inputPerM: 0.85, outputPerM: 0.85 },
  'moonshot-v1-32k': { inputPerM: 0.34, outputPerM: 0.34 },
  'moonshot-v1-8k': { inputPerM: 0.17, outputPerM: 0.17 },
  moonshot: { inputPerM: 0.6, outputPerM: 2.5, cacheReadPerM: 0.15 },

  // === Devin (Cognition SWE-2 ACU-aligned list price) ===
  'swe-2-max': { inputPerM: 5.0, outputPerM: 25.0 },
  'swe-2-high': { inputPerM: 3.5, outputPerM: 17.5 },
  'swe-2-medium': { inputPerM: 2.0, outputPerM: 10.0 },
  'swe-2': { inputPerM: 3.5, outputPerM: 17.5 },
  swe: { inputPerM: 3.5, outputPerM: 17.5 },
  devin: { inputPerM: 3.5, outputPerM: 17.5 },

  // === Muse Code (bundled / local tool — $0 token cost) ===
  muse: { inputPerM: 0, outputPerM: 0 },

  // === DeepSeek (api.deepseek.com/pricing) ===
  'deepseek-reasoner': { inputPerM: 0.55, outputPerM: 2.19, cacheReadPerM: 0.14 },
  'deepseek-chat': { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07 },
  'deepseek-v4-pro': { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.003625 },
  'deepseek-v4-flash-free': { inputPerM: 0, outputPerM: 0 },
  'deepseek-flash': { inputPerM: 0, outputPerM: 0 },
  'deepseek-v4.1-flash-1017': { inputPerM: 0, outputPerM: 0 },
  'deepseek-coder': { inputPerM: 0.14, outputPerM: 0.28 },
  deepseek: { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07 },

  // === xAI Grok (docs.x.ai/docs/overview#pricing) ===
  // Base rates: https://docs.x.ai/developers/grok-4-7 (2026-09-21).
  'grok-4.7': { inputPerM: 2.0, outputPerM: 6.0 },
  // CLI descreve como "Fast variant. 2x the price." do grok-4.7 (models_cache.json, 2026-09-27).
  'grok-4.7-build-fast': { inputPerM: 4.0, outputPerM: 12.0 },
  'grok-code-fast-1': { inputPerM: 0.2, outputPerM: 1.5, cacheReadPerM: 0.02 },
  // F-774: LEGADO — aposentado nas CLIs atuais (fora do models_cache do Grok
  // e deprecated no catálogo); preço mantido só para custo histórico.
  'grok-composer-2.5-fast': { inputPerM: 0.2, outputPerM: 1.5, cacheReadPerM: 0.02 },
  'grok-4-fast': { inputPerM: 0.2, outputPerM: 0.5, cacheReadPerM: 0.05 },
  'grok-4.5': { inputPerM: 2.0, outputPerM: 6.0, cacheReadPerM: 0.5 },
  // 4.6: $2/$6 (docs.x.ai release notes + `devin models list` 2026-09-27).
  'grok-4.6': { inputPerM: 2.0, outputPerM: 6.0, cacheReadPerM: 0.3 },
  'grok-4.1': { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 },
  'grok-4': { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.75 },
  'grok-3-mini': { inputPerM: 0.3, outputPerM: 0.5, cacheReadPerM: 0.075 },
  'grok-3': { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.75 },
  'grok-2': { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.5 },
  grok: { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.75 },

  // === Zhipu AI / GLM (bigmodel.cn/pricing) ===
  'glm-5.3-flash': { inputPerM: 0.07, outputPerM: 0.25, cacheReadPerM: 0.01 },
  // GLM-5.3: $1,40/$4,40 (docs.z.ai + `devin models list` 2026-09-27).
  'glm-5.3': { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  'glm-5.2': { inputPerM: 0.6, outputPerM: 2.2 },
  'glm-4.7-flash': { inputPerM: 0.07, outputPerM: 0.25, cacheReadPerM: 0.01 },
  'glm-4.7': { inputPerM: 0.6, outputPerM: 2.2 },
  'glm-4.6': { inputPerM: 0.6, outputPerM: 2.2 },
  'glm-4.5-air': { inputPerM: 0, outputPerM: 0 },
  'glm-4.5-flash': { inputPerM: 0, outputPerM: 0 },
  glm: { inputPerM: 0.6, outputPerM: 2.2 },

  // === Alibaba Qwen (help.aliyun.com/document_detail/271257.html) ===
  // F-774: família 3.x do DashScope/Bailian (09/2026, F-238) — sem chaves
  // próprias o qwen3.8-max roteado caía no prefixo genérico `qwen` ($0,40/$1,20)
  // em vez do preço Max real.
  'qwen3.8-max': { inputPerM: 1.6, outputPerM: 6.4 },
  'qwen3.7-max': { inputPerM: 1.6, outputPerM: 6.4 },
  'qwen3.7-plus': { inputPerM: 0.4, outputPerM: 1.2 },
  'qwen3.6-plus': { inputPerM: 0.4, outputPerM: 1.2 },
  'qwen3.6-flash': { inputPerM: 0.05, outputPerM: 0.2 },
  'qwen-2.5-coder': { inputPerM: 0.2, outputPerM: 0.6 },
  'qwen-turbo': { inputPerM: 0.05, outputPerM: 0.2 },
  'qwen-plus': { inputPerM: 0.4, outputPerM: 1.2 },
  'qwen-max': { inputPerM: 1.6, outputPerM: 6.4 },
  qwen: { inputPerM: 0.4, outputPerM: 1.2 },

  // === Community / OpenCode free open models ($0) ===
  'opencode/big-pickle': { inputPerM: 0, outputPerM: 0 },
  'big-pickle': { inputPerM: 0, outputPerM: 0 },
  // F-820: SEM o sufixo -free o id é o modelo PAGO do gateway — o F-774 o pôs a
  // $0 por engano, e o F-683 registra "Model access is disabled" justamente
  // nele (não está na lista de modelos sem credencial,
  // CREDENTIALLESS_OPENCODE_MODEL_IDS). Preço = o da família DeepSeek, o mesmo
  // que o prefixo `deepseek` dava antes. Só a variante -free é grátis.
  'opencode/deepseek-v4-flash': { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07 },
  'opencode/deepseek-v4-flash-free': { inputPerM: 0, outputPerM: 0 },
  'opencode/mimo-v2.5-free': { inputPerM: 0, outputPerM: 0 },
  'opencode/nemotron-3-ultra-free': { inputPerM: 0, outputPerM: 0 },

  // === Xiaomi MiMo — official overseas base rates, 2026-09-21 ===
  'mimo-v2.6-pro-ultraspeed': { inputPerM: 4.35, outputPerM: 8.7, cacheReadPerM: 0.036 },
  'mimo-v2.6-pro': { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.0036 },
  'mimo-v2.6-flash': { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028 },
  'mimo-v2.5': { inputPerM: 0.2, outputPerM: 0.6 },
  'mimo-v2': { inputPerM: 0.2, outputPerM: 0.6 },
  mimo: { inputPerM: 0.2, outputPerM: 0.6 },

  // === LongCat ===
  'longcat-2.0': { inputPerM: 0.75, outputPerM: 2.95 },
  longcat: { inputPerM: 0.75, outputPerM: 2.95 },
};

/** Heuristic: ~4 chars per token (used when no real usage counts exist). */
const CHARS_PER_TOKEN = 4;

/** Strip provider namespaces ("moonshot/kimi-k2" → "kimi-k2") and normalize. */
function normalizeModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  return lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
}

/** Resolve the price entry for a model id (longest prefix wins across candidates). */
export function priceForModel(model: string | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const lower = model.trim().toLowerCase();
  const afterLastSlash = normalizeModelId(model);
  const firstSlash = lower.indexOf('/');
  const afterFirstSlash = firstSlash >= 0 ? lower.slice(firstSlash + 1) : lower;

  // Candidates ordered so exact qualified identifiers (e.g. "kimi-code/k3",
  // "opencode/big-pickle") can match directly before falling back to stripped names.
  const candidates = Array.from(new Set([lower, afterLastSlash, afterFirstSlash]));

  let best: { prefix: string; price: ModelPrice } | null = null;
  for (const candidate of candidates) {
    for (const [prefix, price] of Object.entries(MODEL_PRICES)) {
      if (!candidate.startsWith(prefix)) continue;
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, price };
      }
    }
  }
  return best?.price ?? DEFAULT_PRICE;
}

/** Estimated USD cost of a token pair for a model. Pure. */
export function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceForModel(model);
  return (
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM
  );
}

/** Rough token count for a text chunk (~4 chars/token heuristic). Pure. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
