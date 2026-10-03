# handoff-976347bf-5629-4d35-b4c3-2539daddf50d (Antigravity (agy))

# Relatório de Pesquisa e Auditoria de Modelos, Benchmarks e Roteamento — Nexus IDE

**Data de referência:** 03/10/2026  
**Status da execução:** Somente Leitura (`same_checkout` — nenhum arquivo alterado)  
**Escopo:** Avaliação dos modelos do inventário Nexus, evidências públicas de desempenho, auditoria das tabelas do orquestrador e recomendações operacionais de rota e esforço.

---

## 1. Resumo Executivo

O ecossistema de modelos de fronteira em 03/10/2026 passou por consolidações críticas nas últimas semanas:
1. **Modelos de Topo Absoluto (Fronteira):**  
   - O **Claude Opus 5.5** (Anthropic, 22/09) lidera com folga em código agentic rigoroso (**Terminal-Bench 4.0: 66,4%**, DeepSWE v1.1: 74,2%) a um custo 60% menor que o Claude Fable 5.1 ($4/$20 vs $10/$50).  
   - O recém-anunciado **Gemini 4 Argon** (Google, 30/09) atingiu a maior marca oficial de **DeepSWE v1.1: 77,9%**, consolidando nova geração.  
   - O **GPT-6.1 Sol** (OpenAI, 29/09) tornou-se o novo *workhorse* oficial da OpenAI com **DeepSWE v1.1 de 75,2%** empatando/superando o GPT-6 Astra (74,1%) a 1/5 do preço ($2/$10 vs $10/$50) e consumindo cota regular, o que justifica a exclusão do Astra da rota automática geral (F-700).
2. **Revolução dos Modelos Eficientes e Rápidos:**  
   - A reclamação do operador é aritmeticamente comprovada: o **Gemini 3.8 Flash** supera amplamente o **Gemini 3.1 Pro** em código agentic (Vals TB2.1: 81,3% × 70,8%; SWE-bench: 80,0% × 78,8%; Artificial Analysis Index: 41 × 30), custando ~1/3 ($0,75/$3,75 vs $2/$12) e operando 2,6× mais rápido (**306 tok/s** vs 118 tok/s).  
   - Para o Grok, o **Grok 4.7** é o padrão vivo (500k ctx, DeepSWE 71,0%), enquanto variantes como Grok 4.1 e Composer 2.5 estão aposentadas.  
   - **DeepSeek-Flash** (V4.1-Flash) e **Muse Spark 1.3** entregam marcas impressionantes (DeepSWE 74,2% e 75,4%) a custo zero ou ultra-baixo, sendo opções essenciais para tarefas leves e triagem.
3. **Divergências Críticas Encontradas nas Tabelas do Nexus:**  
   - `gemini-4-argon` possui benchmark em `published-benchmarks.ts:62` e entrada no `BUILTIN_MODEL_CATALOG`, mas **falta no `resources/model-catalog.json`** e **não tem preço em `pricing.ts`** (caindo no prefixo fallback `gemini`).  
   - `qwen3.8-max` e a família Qwen 3.x foram integrados como CLI roteável (F-238), mas **não possuem preços específicos em `pricing.ts`** (caem em `qwen` $0.4/$1.2 em vez de max $1.6/$6.4).  
   - Variantes de modelos Kimi (`kimi-for-coding` / highspeed) caem no prefixo `kimi-code` ($0.6/$2.5) em vez do preço real K2.7 ($0.95/$4.0 e $1.9/$8.0).  
   - O `resources/model-ranking.json` permanece congelado em uma fixture desatualizada de meados de setembro (colocando `gpt-5.6-luna` como #1).

---

## 2. Tabela Mestra: Modelo → Benchmarks → Preço → Contexto → Velocidade → Fonte e Data

*Legenda de Fontes:* **[V]** = Primária Verificada (anúncio oficial, system card, documentação do fabricante); **[I]** = Medição Independente Verificada (Artificial Analysis, Vals, Cognition); **[A]** = Agregador de Mercado (BenchLM, DataCamp, The Decoder); **[ND]** = Sem dado público divulgado até 03/10/2026.

| Fabricante / Família | Modelo Exato | SWE-bench / DeepSWE / Terminal-Bench | Índice / Raciocínio (HLE/AA) | Preço 1M Tokens (In / Out) | Janela Contexto | Velocidade (tok/s) | Fonte Primária / Data |
|---|---|---|---|---|---|---|---|
| **Anthropic** | `claude-opus-5-5` | **TB4: 66,4%** [V], DeepSWE: 74,2% [V], SWE-Ver: >96% | HLE: 67,7% [V], AA: 58 [I] | **$4,00 / $20,00** (Cache R: $0,40) | 1.000.000 | 81–94 [I] | Anthropic ([AN1](https://www.anthropic.com/claude-opus-5-5), 22/09/2026) |
| Anthropic | `claude-opus-5` | TB4: 52,3% [V], DeepSWE: 68,8% [V], SWE-Ver: 96,0% [V] | HLE: 56,6% [V] | $5,00 / $25,00 (Cache R: $0,50) | 1.000.000 | ~65–70 [I] | Anthropic ([AN3](https://www.anthropic.com/news/claude-opus-5), 24/07/2026) |
| Anthropic | `claude-fable-5-1` | TB4: 55,8% [V], TB2.1: 91,4% [V/I], DeepSWE: 67,4% [V] | HLE: 65,0% [V], AA: 53 [I] | $10,00 / $50,00 (Assinatura Max: cota 50%) | 1.000.000 | 69 [I] | Anthropic System Card ([AN2](https://www.anthropic.com/claude-fable-and-mythos-5-1), 20/09/2026) |
| Anthropic | `claude-mythos-5-1` | DeepSWE: 67,4% [V] (*sameModelAs* Fable 5.1) | Trusted-access / cyber safety constraints | $10,00 / $50,00 (API only / restrito) | 1.000.000 | [ND] | Anthropic System Card (20/09/2026) |
| Anthropic | `claude-sonnet-5-5` | DeepSWE: 71,0% [V], TB4: [ND] | AA: ~48–50 [I estimado] | **$2,00 / $10,00** (Cache R: $0,20) | 1.000.000 | ~80 [I] | Anthropic / Claude Code 2.1.284 ([doc](https://www.anthropic.com/claude-sonnet-5-5), 28/09/2026) |
| Anthropic | `claude-sonnet-5` | TB2.1: 80,4% [A], SWE-Ver: 85,2% [V] | AA: 38 [I] | $2,00 / $10,00 | 1.000.000 | 69–80 [I] | Anthropic System Card (07/2026) |
| Anthropic | `claude-haiku-4-5` | SWE-Ver: 73,3% [V], TB2.1: [ND] | AA: ~32 [I] | $1,00 / $5,00 | 1.000.000 | 120–140 [I] | Anthropic ([Haiku-4-5](https://www.anthropic.com/news/claude-haiku-4-5), 05/2026) |
| Anthropic | `claude-fable-5` | TB4: 42,0% [V], DeepSWE: 69,7% [V], TB2.1: 84,3% [V] | HLE: 57,8% [V] | $10,00 / $50,00 (API-only) | [ND] | [ND] | Anthropic Fable/Mythos Card (08/2026) |
| Anthropic | `claude-opus-4-8` | DeepSWE: 59,0% [V], TB2.1: 82,7% [V], SWE-Ver: 88,6% [V] | Vals TB2.0: 70,0% [I] | $5,00 / $25,00 | 1.000.000 | ~60 [I] | Anthropic System Card (2026) |
| Anthropic | `claude-sonnet-4-6` / `opus-4-6` | [Legados / substituídos pelas linhas 5 e 5.5] | [ND] | $3,00 / $15,00 | 1.000.000 | 75 [I] | Anthropic (2026) |
| **OpenAI / Codex** | `gpt-6.1-sol` | **DeepSWE: 75,2%** [V], OSWorld 2.0: a 2,1 pts do Astra [V] | AA: 50 (high) / 52 (max) [I] | **$2,00 / $10,00** (Cache R: $0,10) | 1.050.000 | 66 [I] | OpenAI ([O2](https://openai.com/index/introducing-gpt-6-1-sol/), 29/09/2026) |
| OpenAI / Codex | `gpt-6-sol` | DeepSWE: 68,8% [V], TB4: ~43% [A] | AA: 48 [I] | $2,00 / $10,00 (Cache R: $0,20) | 1.050.000 | 86 [I] | OpenAI ([O3](https://openai.com/index/introducing-gpt-6-sol-and-luna/), 22/09/2026) |
| OpenAI / Codex | `gpt-6-luna` | DeepSWE: 66,6% [A/V], OSWorld 2.0: 52,7% [A] | AA: 37 [I] | **$0,10 / $0,50** (Cache R: $0,01) | 1.050.000 | 161 [I] | OpenAI (22/09/2026) |
| OpenAI / Codex | `gpt-6-astra` | DeepSWE: 74,1% [V], TB4: ~58% [V/I], OSWorld: 73,5% [A] | AA: 53 [I], GPQA: 96,0% [A] | **$10,00 / $50,00** (Consome cota 4x-5x) | 1.050.000 | 63 [I] | OpenAI ([O1](https://developers.openai.com/api/docs/models/gpt-6-astra), 09/2026) |
| OpenAI / Codex | `gpt-5.6-sol` | DeepSWE: 72,7% [V], TB2.1: 88,8% [V], TB4: 37,3% [V] | [ND] | Conflito: $5/$30 [Nexus] × $1,20/$6 [Devin] | 1.000.000 | ~65 [I] | OpenAI ([gpt-5-6](https://openai.com/index/gpt-5-6/), 08/2026) |
| OpenAI / Codex | `gpt-5.6-terra` | DeepSWE: 69,6% [V], TB2.1: 87,4% [V] | AA: 42 [I] | $2,00 / $12,00 | 1.000.000 | 100 [I] | OpenAI (08/2026) |
| OpenAI / Codex | `gpt-5.6-luna` | DeepSWE: 67,2% [V], TB2.1: 84,7% [V], SWE-Pro: 62,7% [A] | [ND] | $0,20 / $1,20 | 1.000.000 | 140+ [I] | OpenAI (08/2026) |
| OpenAI / Codex | `gpt-5.5` | [Descontinuado / migra para `gpt-5.6-luna`] | [ND] | $5,00 / $30,00 (histórico) | 1.000.000 | [ND] | OpenAI / Nexus RETIRED_MIGRATIONS |
| OpenAI / Codex | `gpt-reserve` | [Modelo oculto de contingência interna no Codex cache] | [ND] | Sem preço avulso | ~1M | [ND] | `~/.codex/models_cache.json` (09/2026) |
| OpenAI / Codex | `gpt-daybreak-blue-latest` | [Modelo cyber/security do cache do Codex] | [ND] | Sem preço de API pública | 1.050.000 | [ND] | `~/.codex/models_cache.json` (09/2026) |
| **Google / AGY** | `gemini-4-argon` | **DeepSWE: 77,9%** [V], TB2.1: [ND], TB4: não compatível | Topo Google Raciocínio | ~$2,00 / $10,00 (estimado) | 1.000.000+ | ~70 [I] | Google Blog ([Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/), 30/09/2026) |
| Google / AGY | `gemini-3.8-flash` | **TB2.1: 89,4%** [V] / Vals: 81,3% [I], DeepSWE: 73,7% [V] | **AA: 41** [I], HLE-Ver: 54,9% [V] | **$0,75 / $3,75** (após dez/26 $1,50/$7,50) | 1.000.000 | **306** [I] | DeepMind Card ([G1](https://deepmind.google/models/model-cards/gemini-3-8-flash/), 09/2026) |
| Google / AGY | `gemini-3.1-pro` | TB2.0: 68,5% [V] / Vals: 70,8% [I], SWE-bench: 78,8% [I] | **AA: 30** [I] (inferior ao 3.8 Flash), GPQA: 94,3% | $2,00 / $12,00 (3x mais caro que o 3.8) | 1.000.000 | 118 [I] | DeepMind Card ([G4](https://deepmind.google/models/model-cards/gemini-3-1-pro/), 02/2026) |
| Google / AGY | `gemini-3.7-flash` | DeepSWE: 65,3% [V], TB2.1: 85,8% [V], TB4: 11,2% [V] | HLE-Ver: 53,6% [V], AA: 36 [I] | $0,75 / $3,75 (ou free tier low) | 1.000.000 | ~250 [I] | DeepMind Card (08/2026) |
| Google / AGY | `gemini-3.6-flash` | DeepSWE: 49,0% [V], TB2.1: 78,0% [V] | HLE-Ver: 51,2% [V] | $1,50 / $7,50 | 1.000.000 | ~200 [I] | DeepMind Card (2026) |
| **Kimi (Moonshot)** | `kimi-code/k3` | DeepSWE: 67,5% [V], TB2.1: 88,3% [I], TB4: 21,5% [I] | AA: 44 [I], Vals Verified: 93,4% [I] | $3,00 / $15,00 (Cache R: $0,30) | 1.050.000 | 36 [I] | HuggingFace ([K3](https://huggingface.co/moonshotai/Kimi-K3), 09/2026) |
| Kimi (Moonshot) | `kimi-code/k3-256k` | [Mesmo core do K3 otimizado para baixa latência] | AA: ~44 [I] | $3,00 / $15,00 | 262.144 | ~45 [I] | Kimi Provider CLI (09/2026) |
| Kimi (Moonshot) | `kimi-for-coding` / highspeed | SWE-Pro: 58,6% [A], base K2.7 | AA: 26 [I] | $0,95 / $4,00 (Highspeed: $1,90/$8,00) | 262.144 | 87 [I] | api.moonshot.cn (08/2026) |
| **xAI** | `grok-4.7` | DeepSWE: 71,0% [V], TB4: 38% [xAI] vs **26% [AA]** | AA: 46 [I] | $2,00 / $6,00 | 500.000 | 82 [I] | xAI ([X1](https://x.ai/news/grok-4-7), 21/09/2026) |
| xAI | `grok-4.7-build-fast` | DeepSWE: 71,0% [V] (*sameModelAs* Grok 4.7) | AA: 46 [I] | $4,00 / $12,00 (2x o preço de lista) | 500.000 | ~160 [I] | docs.x.ai (21/09/2026) |
| xAI | `grok-composer-2.5-fast` | [ND / Aposentado nas CLIs atuais] | [ND] | $0,20 / $1,50 | [ND] | [ND] | estudo-2026-09.md (09/2026) |
| xAI | `grok-4.6` / `grok-4.5` | 4.6: DeepSWE 65,9%, TB2.1 88,4%; 4.5: DeepSWE 53,0% | 4.6 AA: 44; 4.5 Pro: 64,7% | $2,00 / $6,00 | 500.000 | 66 [I] | xAI Release Notes (07–09/2026) |
| **Zhipu / GLM** | `glm-5.3` | DeepSWE: 66,9% [V], TB2.1: 88,2% [V], TB3.0: 28,3% [A] | AA: 45 [I] | $1,40 / $4,40 (Cache R: $0,26) | 1.000.000 | 87 [I] | HuggingFace ([GLM-5.3](https://huggingface.co/zai-org/GLM-5.3), 09/2026) |
| Zhipu / GLM | `glm-5.3-flash` | DeepSWE: 63,4% [V], TB2.1: 84,3% [V] | AA: 42 [I] | **$0,07 / $0,25** (Cache R: $0,01) | 1.000.000 | 57 [I] | docs.z.ai (09/2026) |
| **Alibaba / Qwen** | `qwen3.8-max` / preview | [ND oficial coding] (UNPUBLISHED_ROUTE_MODELS) | Prior forte coding/agentic interno | $1,60 / $6,40 (Token Plan / Bailian) | 1.000.000 | 55–65 [I] | Alibaba DashScope (09/2026, F-238) |
| Alibaba / Qwen | `qwen3.7-max` / `plus` | [ND oficial coding] | [ND] | Plus: $0,40/$1,20; Max: $1,60/$6,40 | 1.000.000 | 80 [I] | Alibaba DashScope (09/2026) |
| Alibaba / Qwen | `qwen3.6-plus` / `flash` | [ND oficial coding] | [ND] | Flash: $0,05/$0,20 (ou free) | 1.000.000 | 120–150 [I] | Alibaba DashScope (09/2026) |
| **Xiaomi MiMo** | `xiaomi/mimo-v2.6-pro` | DeepSWE: 71,9% [V], TB2.1: 89,9% [V], **TB4: 34,9%** [V] | **AA: 46** [V/I] (topo open-weights) | **$0,435 / $0,87** (Cache R: $0,0036) | 1.050.000 | 44 [I] | HuggingFace ([MiMo-Pro](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL), 22/09/2026) |
| Xiaomi MiMo | `xiaomi/mimo-v2.6-flash` | DeepSWE: 67,9% [V], TB2.1: 87,6% [V], TB4: 28,8% [V] | AA: 38 [I], OSWorld-Ver: 80,8% [V] | **$0,14 / $0,28** (Cache R: $0,0028) | 1.050.000 | 60 [I] | HuggingFace ([MiMo-Flash](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL), 22/09/2026) |
| Xiaomi MiMo | `mimo-v2.6-pro-ultraspeed`| *sameModelAs* Pro (DeepSWE 71,9%, TB2.1 89,9%) | AA: 46 [I] | $4,35 / $8,70 (API-only, fora plan) | 1.050.000 | até 20x (~800) | Xiaomi News (22/09/2026) |
| **MiniMax** | `minimax/MiniMax-M3` | SWE-Ver: 80,5% [V], TB2.1: 66,0% [V/A] | AA: 29 [I] | $0,23 / $0,96 (ou incluso no mcode) | 1.000.000 | 179 [I] | MiniMax Blog ([M3](https://www.minimax.io/blog/minimax-m3), 08/2026) |
| MiniMax | `MiniMax-M3.1-Flash-Preview`| *successorOf* M3 (herda SWE 80,5% como piso) | [ND próprio consolidado] | Incluso na assinatura `mcode` | 1.000.000 | ~200 [I] | DataNorth AI (27/09/2026) |
| **Meta / Muse** | `muse-spark-1.3` | **DeepSWE: 75,4%** [V], **TB2.1: 88,8%** [V] | AA: 48 [I] | **$0,00** (Local/Bundled no Nexus) | 1.000.000 | **205** [I] | Meta AI Dev ([Muse](https://dev.meta.ai/models/muse-spark/), 09/2026) |
| **Cognition / Devin** | `swe-2` (med/high/max) | DeepSWE: 73,0% [V], **TB2.1: 92,8%** [V], TB4: 27,3% [V]| Base K3 fine-tuned Cognition | Incluso no plano Devin ($2–$5/M) | 262.144 | Agentic harness | Cognition Blog ([SWE-2](https://cognition.com/blog/swe-2), 10/09/2026) |
| **DeepSeek** | `deepseek-v4-pro` | DeepSWE: 62,7% [V], TB2.1: 87,9% [V] | AA: ~45 [I] | $0,435 / $0,87 (Cache R: $0,0036) | 1.000.000 | ~60 [I] | HuggingFace (08/2026) |
| DeepSeek | `deepseek-flash` (V4.1) | **DeepSWE: 74,2%** [V], **TB2.1: 90,6%** [V], TB4: 27% [I] | AA: 39 [I] | **$0,00** (Free no adapter Nexus) | 1.000.000 | **232** [I] | HuggingFace ([DS-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), 09/2026) |
| **OpenCode** | `opencode/big-pickle` | [ND oficial] (modelo open da comunidade) | [ND] | $0,00 (Free sem credencial) | ~128k | [ND] | OpenCode registry (09/2026) |
| OpenCode | `opencode/deepseek-v4-flash` | *sameModelAs* DeepSeek-Flash (74,2% / 90,6%) | AA: 39 [I] | $0,00 | 1.000.000 | ~200+ | OpenCode registry (09/2026) |
| OpenCode | `nemotron-3-ultra-free` | [ND oficial coding] (open weights NVIDIA) | [ND] | $0,00 (Free sem credencial) | [ND] | [ND] | OpenCode registry (09/2026) |

---

## 3. Divergências Encontradas nas Tabelas do Nexus IDE

Abaixo estão as discrepâncias exatas mapeadas por `arquivo:linha`, com o valor atual registrado no repositório e o valor proposto para correção:

### A. Preços (`src/main/orch/pricing.ts`)
1. **`src/main/orch/pricing.ts:110` (Gemini 4 Argon ausente)**  
   - **Valor atual:** Não existe chave para `gemini-4-argon`. Qualquer cálculo de custo cai no prefixo genérico `gemini` (`inputPerM: 1.25, outputPerM: 10`).  
   - **Valor proposto:** Adicionar `'gemini-4-argon': { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.2 },` (conforme documentado em `model-catalog.ts:198` e anúncio oficial).
2. **`src/main/orch/pricing.ts:199-205` (Preços da família Qwen 3.x ausentes)**  
   - **Valor atual:** Apenas chaves antigas (`qwen-2.5-coder`, `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen`). O modelo padrão roteado `qwen3.8-max` cai no prefixo genérico `qwen` ($0,40 / $1,20) em vez do valor Max ($1,60 / $6,40).  
   - **Valor proposto:** Adicionar entradas explícitas:  
     ```ts
     'qwen3.8-max': { inputPerM: 1.6, outputPerM: 6.4 },
     'qwen3.7-max': { inputPerM: 1.6, outputPerM: 6.4 },
     'qwen3.7-plus': { inputPerM: 0.4, outputPerM: 1.2 },
     'qwen3.6-plus': { inputPerM: 0.4, outputPerM: 1.2 },
     'qwen3.6-flash': { inputPerM: 0.05, outputPerM: 0.2 },
     ```
3. **`src/main/orch/pricing.ts:132-148` (Aliases dos modelos Kimi sem preço explícito)**  
   - **Valor atual:** IDs configurados no `config.toml` e listados no adapter (`kimi-code/kimi-for-coding` e `kimi-code/kimi-for-coding-highspeed`) caem no prefixo `kimi-code` ($0,60 / $2,50). Na realidade, representam o K2.7 ($0,95 / $4,00 e $1,90 / $8,00).  
   - **Valor proposto:** Adicionar:  
     ```ts
     'kimi-code/kimi-for-coding-highspeed': { inputPerM: 1.9, outputPerM: 8.0, cacheReadPerM: 0.38 },
     'kimi-code/kimi-for-coding': { inputPerM: 0.95, outputPerM: 4.0, cacheReadPerM: 0.19 },
     ```
4. **`src/main/orch/pricing.ts:175` (Modelo descontinuado `grok-composer-2.5-fast`)**  
   - **Valor atual:** Mantido ativo na tabela de preços.  
   - **Valor proposto:** Anotar como legado/descontinuado (não mais listado em `models_cache.json` do Grok).

### B. Catálogo de Recursos (`resources/model-catalog.json`)
1. **`resources/model-catalog.json:235-293` (Falta `gemini-4-argon` no catálogo publicado)**  
   - **Valor atual:** O `adapters.agy.models` lista apenas as famílias 3.8, 3.7 e 3.6 (`updatedAt: 2026-09-29`). O `gemini-4-argon` foi anunciado em 30/09 e está presente no código TypeScript (`BUILTIN_MODEL_CATALOG`), mas não no JSON exportado.  
   - **Valor proposto:** Injetar em `adapters.agy.models`:  
     `{ "id": "gemini-4-argon", "availability": "paid", "costTier": "high", "source": "remote" }` e atualizar `updatedAt`.
2. **`resources/model-catalog.json:6` (Default do Claude desatualizado)**  
   - **Valor atual:** `"default": "claude-sonnet-5"`.  
   - **Valor proposto:** Com a validação oficial do Sonnet 5.5 em 28/09 (mesmo preço $2/$10 e melhor capacidade), atualizar para `"default": "claude-sonnet-5-5"` mantendo Sonnet 5 como fallback.
3. **`resources/model-catalog.json:158` (`grok-composer-2.5-fast`)**  
   - **Valor atual:** Modelo listado no adapter Grok.  
   - **Valor proposto:** Remover ou marcar `"availability": "deprecated"`.

### C. Roteamento de Tarefas (`src/main/orch/task-router.ts`)
1. **`src/main/orch/task-router.ts:145` (Grok 4.7 liderando o tier trivial a custo elevado)**  
   - **Valor atual:** Linha 145 define `{ adapterId: 'grok', model: GROK_FRONTIER_MODEL, effort: 'low' }` como 1ª opção de trivial ($2,00 / $6,00).  
   - **Valor proposto:** Conforme apontado no `estudo-2026-09.md:127`, rotinas triviais deveriam ser lideradas por modelos baratos de alta velocidade: `codex: gpt-6-luna` ($0,10 / $0,50, 161 tok/s) ou `agy: gemini-3.7-flash-low` / `gemini-3.8-flash-low` ($0,75/$3,75 ou grátis no agy).
2. **`src/main/orch/task-router.ts:220, 261` (Modelos legados no OpenCode)**  
   - **Valor atual:** `openrouter/anthropic/claude-sonnet-5` no medium e `openrouter/anthropic/claude-opus-4.8` no hard.  
   - **Valor proposto:** Atualizar as rotas do OpenCode para apontar para `openrouter/anthropic/claude-sonnet-5.5` e `openrouter/anthropic/claude-opus-5-5`.

### D. Ranking Global (`resources/model-ranking.json`)
1. **`resources/model-ranking.json:1-280` (Fixture antiga de 13/09/2026)**  
   - **Valor atual:** `suiteRevision: "fixture"`, ranking #1 com `gpt-5.6-luna` e #3 com `claude-opus-5-5`. O roteador ignora o arquivo em runtime por ser fixture (`hasAuthoritativeModelQuality: false`).  
   - **Valor proposto:** Gerar nova rodada real de `nexus-eval` ou manter documento anotado claramente como *obsoleto/não-autoritativo*.

---

## 4. Recomendações por Tipo de Tarefa e Controle de Esforço

Para equilibrar custo, qualidade medida e diversidade entre provedores (evitando dependência de uma única CLI):

### 4.1. Matriz de Recomendação por Especialidade

| Tipo de Tarefa | Melhor Modelo (Frontier / Lead) | Alternativa Barata / Eficiente | Esforço Recomendado | Racional Técnico & Diversidade |
|---|---|---|---|---|
| **1. Revisão de Segurança** | **Claude Opus 5.5** (`claude`) / **Claude Fable 5.1** (`claude` cross-review) | **MiMo-V2.6-Pro** (`mimo-code`) ou **DeepSeek-V4-Pro** (`deepseek`) | `high` (ou `xhigh` em crítico) | SEC Bench Pro 66,3% e ExploitBench 47,9% no MiMo Pro tornam-no a melhor alternativa barata ($0,435/$0,87) ao Opus 5.5. |
| **2. Bug Difícil / Investigação Raiz** | **Claude Opus 5.5** (`claude`) ou **GPT-6.1 Sol** (`codex`) | **Gemini 3.8 Flash** (`agy`) ou **Muse Spark 1.3** (`muse`) | `high` | GPT-6.1 Sol (DeepSWE 75,2%) e Opus 5.5 (TB4 66,4%) lideram raciocínio. Gemini 3.8 Flash (306 tok/s, $0,75/$3,75) e Muse ($0) resolvem rápido a custo ínfimo. |
| **3. Feature (Nova Funcionalidade)** | **GPT-6.1 Sol** (`codex`) ou **Claude Sonnet 5.5** (`claude`) | **GLM-5.3** (`glm`) ou **Kimi K3** (`kimi`) | `medium` | Descentraliza do Claude/OpenAI para o ecossistema Z.AI (GLM-5.3, TB2.1 88,2%, $1,40/$4,40) e Kimi K3 (1M ctx). |
| **4. UI / Visual / Frontend** | **Claude Opus 5.5** (`claude`) ou **Claude Sonnet 5.5** (`claude`) | **Gemini 3.8 Flash** (`agy`) ou **Grok 4.7** (`grok`) | `medium` | Lane Visual F-227 do operador: modelos Anthropic lideram estrita fidelidade estética e hierarquia visual; Gemini traz visão multimodal rápida. |
| **5. Documentação / PRD / Specs** | **Claude Sonnet 5.5** (`claude`) ou **Grok 4.7** (`grok`) | **GLM-5.3-Flash** (`glm-flash`) ou **Gemini 3.8 Flash** (`agy`) | `low` | Tarefa centrada em texto com baixo risco de compilação; GLM Flash a $0,07/$0,25 é praticamente imbatível em custo. |
| **6. Pesquisa com Web / Grounding** | **Grok 4.7** (`grok`) ou **Gemini 3.8 Flash** (`agy`) | **Kimi K3** (`kimi`) | `low` a `medium` | Grok (busca X/web em tempo real) e Gemini (grounding Google/BrowseComp 85,9%) superam CLIs puramente offline; Kimi tem busca integrada forte. |
| **7. Triagem Rápida / Inspeção Read-Only** | **Gemini 3.8 Flash** (`agy`) ou **GPT-6 Luna** (`codex`) | **DeepSeek-Flash** (`deepseek`) ou **OpenCode Big-Pickle** (`opencode`) | `low` | Velocidade bruta (306 tok/s e 161 tok/s) e custo quase zero ($0,10/$0,50 ou free) permitem triagem em segundos sem queimar cota. |
| **8. Refatoração Grande (Multi-arquivo)** | **Claude Opus 5.5** (`claude`) ou **Devin SWE-2 High** (`devin`) | **Muse Spark 1.3** (`muse`) ou **MiMo-V2.6-Pro** (`mimo-code`) | `high` | 1M de tokens com baixo erro de contexto longo no Opus 5.5; Muse Spark (DeepSWE 75,4%) atua como alternativa sem custo de API. |

---

### 4.2. O que "Esforço" (Reasoning Effort) Significa em Cada CLI

Nem todas as CLIs operam esforço da mesma forma. O Nexus IDE classifica as CLIs em três grupos operacionais:

1. **CLIs com Parâmetro de Linha de Comando Nativo (`control.effort` ativo):**
   - **Claude Code (`claude`):** Flag `--effort <low|medium|high|xhigh>`. Controla diretamente o orçamento de tokens do *Extended Thinking* da Anthropic.
   - **Codex CLI (`codex`):** Flag `-c model_reasoning_effort=<low|medium|high|xhigh|max>`. Configura a intensidade de raciocínio da família GPT-6 (Sol, Luna, Astra) e o3/o4.
   - **Antigravity CLI (`agy`):** Flag `--effort <low|medium|high>`. Controla o reasoning do Gemini. *Atenção (F-705):* Não suporta `xhigh`. O nível de esforço precisa casar com o sufixo do ID selecionado (`gemini-3.8-flash-high` exige `--effort high`), senão a CLI rejeita a execução.
   - **xAI Grok (`grok`):** Flag `--reasoning-effort <low|medium|high|xhigh>`. Determina o número de passos de auto-correção e reflexão do Grok 4.7.
   - **GLM & GLM-Flash (`glm`, `glm-flash`):** Flag `--effort <low|medium|high|xhigh>`. Opera sobre o wrapper da CLI Claude apontado para a Z.AI, consumindo a mesma sintaxe de Extended Thinking.
   - **DeepSeek (`deepseek`):** Flag `--effort <low|medium|high|xhigh>`. Opera via wrapper Claude direcionado à API DeepSeek, ativando tokens de raciocínio no `deepseek-v4-pro`.
   - **Muse (`muse`):** Flag `--reasoning-effort <low|medium|high|xhigh>`.
   - **LongCat (`longcat`), Muse-Claude (`muse-claude`):** Flag `--effort <low|medium|high|xhigh>`.
   - **OpenClaude (`openclaude`):** Flag `--effort <low|medium|high|xhigh|max|ultracode>`.

2. **CLIs com Esforço Embutido no Identificador do Modelo:**
   - **Devin (`devin`):** O adapter possui `"effort": null`. O esforço **não é passado por flag**, mas sim codificado no próprio ID do modelo selecionado (ex.: `swe-2-medium`, `swe-2-high`, `swe-2-max`, `claude-opus-5-5-high`).

3. **CLIs que Ignoram Esforço via CLI (Sem suporte a flag no adapter):**
   - **Kimi (`kimi`):** `"effort": null`. A CLI do Kimi Code roda com o comportamento padrão do modelo; variáveis de ambiente como `KIMI_MODEL_THINKING_EFFORT` existem no passthrough, mas não são injetadas como argv de spawn.
   - **Xiaomi MiMo (`mimo-code`):** `"effort": null`. O binário `mimo` não aceita argumento de esforço verificado em modo interativo; adota o default nativo do modelo.
   - **MiniMax Code (`minimax-code`):** `"effort": null`. O TUI do `mcode` ignora parâmetros de esforço.
   - **Qwen Code (`qwen`):** `"effort": null`. O fork do Gemini CLI do Qwen Code não possui argumento de reasoning configurado.
   - **OpenCode (`opencode`) & Aider (`aider`):** `"effort": null`. Não expõem controle de esforço via CLI.

---

## 5. O Que Foi Verificado vs. O Que É Inferência / Não Verificado

Com base no contrato de honestidade intelectual e rigor empírico do Nexus IDE:

### A. Estritamente Verificado (Evidência Primária ou Código)
- Todos os arquivos de configuração, schemas e tabelas internas do repositório Nexus (`published-benchmarks.ts`, `pricing.ts`, `model-catalog.json`, `task-router.ts`, `model-defaults.ts`, `model-line.ts`, `squad-model-defaults.ts` e arquivos `.json` de `src/adapters/builtin/`).
- Números de benchmarks oficiais primários: DeepSWE v1.1 para Gemini 4 Argon (77,9%), Claude Opus 5.5 (74,2%), GPT-6.1 Sol (75,2%), Grok 4.7 (71,0%), Muse Spark 1.3 (75,4%), DeepSeek-Flash (74,2%), MiMo Pro (71,9%).
- Terminal-Bench 4.0 oficial medido para Claude Opus 5.5 (66,4%), Claude Fable 5.1 (55,8%), Claude Opus 5 (52,3%) e MiMo Pro (34,9%).
- Superioridade documentada e validada do Gemini 3.8 Flash sobre o Gemini 3.1 Pro em código/agentic e velocidade.
- Suporte a flags de permissão, spawn e esforço lidos diretamente dos contratos de adapters do Nexus.

### B. Inferência Fundamentada
- Preço da API do `gemini-4-argon`: estimado em $2,00/$10,00 com base no anúncio da Google e no comentário interno de `model-catalog.ts:198`, aguardando consolidação na tabela de preços pública da Google Cloud.
- Velocidade de geração do `claude-sonnet-5-5` (~80 tok/s) e `MiniMax-M3.1-Flash-Preview` (~200 tok/s): inferidas a partir da linhagem direta e medições preliminares da CLI.
- Comportamento de pontuação para o `MiniMax-M3.1-Flash-Preview`: inferido por herança (*successorOf*) da nota do M3.

### C. Não Verificado / Sem Dado Público
- Modelos sem benchmarks de coding públicos divulgados até 03/10/2026: `qwen3.8-max`, `qwen3.7-max/plus`, `qwen3.6-plus/flash`, `gpt-reserve`, `gpt-daybreak-blue-latest`, `grok-composer-2.5-fast`, `big-pickle`, `nemotron-3-ultra-free` (mantidos na lista `UNPUBLISHED_ROUTE_MODELS`).
- Preço de lista oficial inequívoco do `gpt-5.6-sol`: persiste divergência histórica entre fontes ($5/$30 vs $1,20/$6).
- Estado de cota e cooldown das contas ativas do usuário: o presente estudo mapeia o software e a literatura técnica; nenhuma chamada cobrada ou teste invasivo de token foi executado contra a conta do usuário neste pane.
