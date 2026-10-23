/**
 * Benchmarks OFICIAIS publicados pelos fabricantes (F-675).
 *
 * Nenhum modelo do catálogo tem avaliação `nexus-eval`, então o roteador dava a
 * mesma nota baixa a todos e decidia só pela ordem da tabela. Estes números
 * vêm da fonte primária (system card, model card, página ou paper do
 * fabricante) coletada em 2026-09-28; modelo sem número publicado fica de fora
 * — nunca se inventa nota. `sameModelAs` só onde o fabricante declara que a
 * variante é o mesmo modelo servido mais rápido.
 *
 * `successorOf` (regra do operador, 29/09: "sempre os modelos mais novos"):
 * a versão nova do fabricante que ainda não publicou número herda a nota do
 * antecessor como piso. Não é número dela; é o que impede o mais novo de
 * perder para o antigo só por falta de benchmark. Quando o fabricante
 * publicar, os números próprios substituem a herança.
 *
 * Benchmarks usados (os de maior cobertura entre fabricantes hoje):
 *   - DeepSWE v1.1 (%), Terminal-Bench 2.1 (%), SWE-bench Verified (%).
 * Versões diferentes de Terminal-Bench (2.0, 3.0, 4.0) NÃO entram: não são
 * comparáveis entre si.
 */
import { isNewerModelVersion, modelLineOf } from '../../shared/model-line';

export interface PublishedBenchmark {
  readonly deepSWE?: number;
  readonly terminalBench21?: number;
  readonly swebenchVerified?: number;
  readonly sameModelAs?: string;
  readonly successorOf?: string;
  readonly source: string;
}

export const PUBLISHED_BENCHMARKS: Readonly<Record<string, PublishedBenchmark>> = Object.freeze({
  'claude:claude-opus-5-5': { deepSWE: 74.2, source: 'https://www.anthropic.com/claude-opus-5-5' },
  'claude:claude-opus-5': { deepSWE: 68.8, swebenchVerified: 96.0, source: 'https://www.anthropic.com/claude-opus-5-system-card' },
  'claude:claude-fable-5-1': { deepSWE: 67.4, source: 'https://www.anthropic.com/claude-fable-5-1' },
  'claude:claude-mythos-5-1': { sameModelAs: 'claude:claude-fable-5-1', source: 'Fable 5.1 & Mythos 5.1 System Card' },
  'claude:claude-fable-5': { deepSWE: 69.7, terminalBench21: 84.3, swebenchVerified: 95.0, source: 'https://www.anthropic.com/claude-fable-5-mythos-5-system-card' },
  'claude:claude-opus-4-8': { deepSWE: 59.0, terminalBench21: 82.7, swebenchVerified: 88.6, source: 'https://www.anthropic.com/claude-opus-4-8-system-card' },
  'claude:claude-sonnet-5-5': { deepSWE: 71.0, source: 'https://www.anthropic.com/claude-sonnet-5-5' },
  'claude:claude-sonnet-5': { terminalBench21: 80.4, swebenchVerified: 85.2, source: 'https://www.anthropic.com/claude-sonnet-5-system-card' },
  'claude:claude-haiku-4-5': { swebenchVerified: 73.3, source: 'https://www.anthropic.com/news/claude-haiku-4-5' },
  'codex:gpt-6.1-sol': { deepSWE: 75.2, source: 'https://openai.com/index/introducing-gpt-6-1-sol/' },
  'codex:gpt-6-sol': { deepSWE: 68.8, source: 'https://openai.com/index/introducing-gpt-6-sol-and-luna/' },
  'codex:gpt-6-luna': { deepSWE: 66.6, source: 'https://openai.com/index/introducing-gpt-6-sol-and-luna/' },
  'codex:gpt-6-astra': { deepSWE: 74.1, source: 'https://openai.com/index/gpt-6-astra/' },
  'codex:gpt-5.6-sol': { deepSWE: 72.7, terminalBench21: 88.8, source: 'https://openai.com/index/gpt-5-6/' },
  'codex:gpt-5.6-terra': { deepSWE: 69.6, terminalBench21: 87.4, source: 'https://openai.com/index/gpt-5-6/' },
  'codex:gpt-5.6-luna': { deepSWE: 67.2, terminalBench21: 84.7, source: 'https://openai.com/index/gpt-5-6/' },
  'grok:grok-4.7': { deepSWE: 71.0, source: 'https://x.ai/news/grok-4-7' },
  'grok:grok-4.7-build-fast': { sameModelAs: 'grok:grok-4.7', source: 'https://docs.x.ai/developers/grok-4-7' },
  'grok:grok-4.6': { deepSWE: 65.9, source: 'https://x.ai/news/grok-4-6' },
  'grok:grok-4.5': { deepSWE: 53.0, terminalBench21: 83.3, source: 'https://x.ai/news/grok-4-5' },
  'glm:glm-5.3': { deepSWE: 66.9, terminalBench21: 88.2, source: 'https://huggingface.co/zai-org/GLM-5.3' },
  'glm:glm-5.3-flash': { deepSWE: 63.4, terminalBench21: 84.3, source: 'https://docs.z.ai/guides/llm/glm-5.3-flash' },
  'glm:glm-5.2': { deepSWE: 46.2, terminalBench21: 81.0, source: 'https://huggingface.co/zai-org/GLM-5.2' },
  'glm:glm-4.7': { swebenchVerified: 73.8, source: 'https://huggingface.co/zai-org/GLM-4.7' },
  'glm:glm-4.5-air': { swebenchVerified: 57.6, source: 'https://arxiv.org/abs/2508.06471' },
  'glm:glm-4.7-flash': { swebenchVerified: 59.2, source: 'https://huggingface.co/zai-org/GLM-4.7-Flash' },
  // Gemini 4 Argon (30/09): o anúncio oficial publica só DeepSWE v1.1 (77,9%);
  // Terminal-Bench 2.1 não foi divulgado (o 4.0 não é comparável — F-675).
  'agy:gemini-4-argon': { deepSWE: 77.9, source: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/' },
  'agy:gemini-3.8-flash': { deepSWE: 73.7, terminalBench21: 89.4, source: 'https://deepmind.google/models/model-cards/gemini-3-8-flash/' },
  'agy:gemini-3.7-flash': { deepSWE: 65.3, terminalBench21: 85.8, source: 'https://deepmind.google/models/model-cards/gemini-3-7-flash/' },
  'agy:gemini-3.6-flash': { deepSWE: 49.0, terminalBench21: 78.0, source: 'https://deepmind.google/models/model-cards/gemini-3-6-flash/' },
  // K3.1 Pro (23/10): tabela oficial com as mesmas DeepSWE de Fable 5.1 (67,4)
  // e Astra (74,1) acima. Highspeed: "identical model capabilities" na doc do
  // Kimi Code — só a velocidade e a cota mudam.
  'kimi:kimi-code/k3.1-pro': { deepSWE: 75.5, source: 'https://www.kimi.ai/blog/kimi-k3-1-pro' },
  'kimi:kimi-code/k3.1-pro-highspeed': { sameModelAs: 'kimi:kimi-code/k3.1-pro', source: 'https://www.kimi.com/code/docs/en/kimi-code/models.html' },
  'kimi:kimi-code/k3': { deepSWE: 67.5, terminalBench21: 88.3, source: 'https://huggingface.co/moonshotai/Kimi-K3' },
  'devin:swe-2': { deepSWE: 73.0, terminalBench21: 92.8, source: 'https://cognition.com/blog/swe-2' },
  'longcat:LongCat-2.0': { terminalBench21: 70.8, source: 'https://huggingface.co/meituan-longcat/LongCat-2.0' },
  'deepseek:deepseek-flash': { deepSWE: 74.2, terminalBench21: 90.6, source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash' },
  'claude:deepseek-flash': { sameModelAs: 'deepseek:deepseek-flash', source: 'DeepSeek Flash no Claude' },
  'qwen:deepseek-flash': { sameModelAs: 'deepseek:deepseek-flash', source: 'DeepSeek Flash no Qwen Code' },
  'deepseek:deepseek-v4-pro': { deepSWE: 62.7, terminalBench21: 87.9, source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813' },
  'muse:muse-spark-1.3': { deepSWE: 75.4, terminalBench21: 88.8, source: 'https://dev.meta.ai/models/muse-spark/' },
  // F-1391: tabela oficial da Meta (12/10), mesma DeepSWE das linhas Opus 5.5
  // (74,2), GPT-6 Astra (74,1) e Fable 5.1 (67,4) acima. Sem Terminal-Bench
  // 2.1 publicado (a Meta mostra o 4.0-AA, outra escala).
  'muse:muse-wonder-full-1.0': { deepSWE: 79.0, source: 'https://dev.meta.ai/models/muse-wonder/' },
  'muse:muse-wonder-1.0': { deepSWE: 78.8, source: 'https://dev.meta.ai/models/muse-wonder/' },
  'mimo-code:xiaomi/mimo-v2.6-pro': { deepSWE: 71.9, terminalBench21: 89.9, source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL' },
  'mimo-code:xiaomi/mimo-v2.6-flash': { deepSWE: 67.9, terminalBench21: 87.6, source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL' },
  'minimax-code:minimax/MiniMax-M3.1-Flash-Preview': { successorOf: 'minimax-code:minimax/MiniMax-M3', source: 'https://datanorth.ai/news/minimax-releases-m3-1-flash-preview' },
  // F-1649: documented succession only, not a measured GA score. Preserve
  // historical Preview/M3 records and attribute the inherited floor below.
  'minimax-code:minimax/MiniMax-M3.1-Flash': { successorOf: 'minimax-code:minimax/MiniMax-M3.1-Flash-Preview', source: 'https://agent.minimax.io/tools/m3.1-flash' },
  'minimax-code:minimax/MiniMax-M3': { swebenchVerified: 80.5, terminalBench21: 66.0, source: 'https://www.minimax.io/blog/minimax-m3' },
  'minimax-code:minimax/MiniMax-M2.7': { swebenchVerified: 79.9, terminalBench21: 51.1, source: 'https://www.minimax.io/blog/minimax-m3' },
  'minimax-code:minimax/MiniMax-M2.7-highspeed': { sameModelAs: 'minimax-code:minimax/MiniMax-M2.7', source: 'https://www.minimax.io/models/text/m27' },
});

/** Faixa observada de cada benchmark entre os modelos do catálogo (0..1 após normalizar). */
const RANGES = {
  deepSWE: [45, 76],
  terminalBench21: [50, 93],
  swebenchVerified: [57, 96],
} as const;

/** Adapters que rodam os mesmos modelos de outro adapter (a chave do benchmark é a do dono). */
const ADAPTER_ALIASES: Readonly<Record<string, string>> = { 'glm-flash': 'glm', 'muse-claude': 'muse' };

/** Chave do benchmark para um id de modelo do catálogo (variantes de esforço e contexto). */
export function publishedBenchmarkKey(adapterId: string, model: string): string {
  const adapter = ADAPTER_ALIASES[adapterId] ?? adapterId;
  let id = model.replace(/\[[^\]]*\]$/u, '');
  if (adapter === 'agy') id = id.replace(/-(?:low|medium|high)$/u, '');
  if (adapter === 'devin') id = id.replace(/^swe-2-(?:medium|high|max)$/u, 'swe-2');
  return `${adapter}:${id}`;
}

function hasOwnNumbers(entry: PublishedBenchmark): boolean {
  return (Object.keys(RANGES) as Array<keyof typeof RANGES>)
    .some((key) => typeof entry[key] === 'number');
}

/**
 * Piso de linha em runtime (F-217, a mesma regra do `successorOf`, agora para
 * modelo que a CLI anuncia antes de qualquer catálogo): sem entrada direta,
 * procura a publicação MAIS RECENTE da mesma linha no mesmo adapter
 * (normalizado) e herda a nota dela. Nunca herda de um modelo mais novo, e
 * uma entrada direta sempre vence.
 */
function predecessorBenchmarkKey(adapterId: string, model: string): string | null {
  const key = publishedBenchmarkKey(adapterId, model);
  const prefix = key.slice(0, key.indexOf(':') + 1);
  const target = modelLineOf(key.slice(prefix.length));
  let best: string | null = null;
  let bestVersion: readonly number[] = [];
  for (const candidateKey of Object.keys(PUBLISHED_BENCHMARKS)) {
    if (!candidateKey.startsWith(prefix)) continue;
    const line = modelLineOf(candidateKey.slice(prefix.length));
    if (line.stem !== target.stem) continue;
    if (!isNewerModelVersion(target.version, line.version)) continue;
    if (best && !isNewerModelVersion(line.version, bestVersion)) continue;
    best = candidateKey;
    bestVersion = line.version;
  }
  return best;
}

/**
 * De quem são os números (F-1588): do próprio modelo, de uma variante de
 * esforço/contexto do mesmo modelo, do mesmo modelo servido por outro id
 * (`sameModelAs`) ou de um antecessor da linha (piso do modelo mais novo).
 */
export type PublishedBenchmarkOrigin = 'own' | 'variant' | 'same-model' | 'predecessor';

export interface ResolvedPublishedBenchmark {
  readonly entry: PublishedBenchmark;
  /** Chave `adapter:modelo` dona dos números. */
  readonly key: string;
  readonly origin: PublishedBenchmarkOrigin;
}

export function resolvePublishedBenchmark(
  adapterId: string,
  model: string,
): ResolvedPublishedBenchmark | null {
  const directKey = publishedBenchmarkKey(adapterId, model);
  let key: string | null = PUBLISHED_BENCHMARKS[directKey] ? directKey : null;
  let origin: PublishedBenchmarkOrigin =
    directKey.slice(directKey.indexOf(':') + 1) === model ? 'own' : 'variant';
  if (!key) {
    key = predecessorBenchmarkKey(adapterId, model);
    origin = 'predecessor';
  }
  for (let hops = 0; key && hops < 4; hops += 1) {
    const entry: PublishedBenchmark | undefined = PUBLISHED_BENCHMARKS[key];
    if (!entry) return null;
    if (entry.sameModelAs) {
      if (origin !== 'predecessor') origin = 'same-model';
      key = entry.sameModelAs;
      continue;
    }
    if (!hasOwnNumbers(entry) && entry.successorOf) {
      origin = 'predecessor';
      key = entry.successorOf;
      continue;
    }
    return { entry, key, origin };
  }
  const last = key ? PUBLISHED_BENCHMARKS[key] : undefined;
  return key && last ? { entry: last, key, origin } : null;
}

export function publishedBenchmarkFor(adapterId: string, model: string): PublishedBenchmark | null {
  return resolvePublishedBenchmark(adapterId, model)?.entry ?? null;
}

/**
 * Média 0..1 das posições normalizadas nos benchmarks publicados.
 * `null` quando o fabricante não publicou nenhum dos três — nunca se
 * inventa nota.
 */
function publishedNormalizedMean(entry: PublishedBenchmark): number | null {
  const normalized: number[] = [];
  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const value = entry[key];
    if (typeof value !== 'number') continue;
    const [lo, hi] = RANGES[key];
    normalized.push(Math.min(1, Math.max(0, (value - lo) / (hi - lo))));
  }
  if (normalized.length === 0) return null;
  return normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
}

/** A mesma média do roteador em 0..100 (uma casa); `null` sem número publicado. */
export function publishedEntryScore100(entry: PublishedBenchmark): number | null {
  const mean = publishedNormalizedMean(entry);
  return mean === null ? null : Math.round(mean * 1000) / 10;
}

/**
 * Nota de qualidade 6..24 para o roteador (mesma escala do termo `quality` do
 * pipeline): média das posições normalizadas nos benchmarks publicados.
 * `null` quando o fabricante não publicou nenhum dos três.
 */
export function publishedCodingQuality(adapterId: string, model: string): number | null {
  const entry = publishedBenchmarkFor(adapterId, model);
  if (!entry) return null;
  const mean = publishedNormalizedMean(entry);
  if (mean === null) return null;
  return Math.round((6 + 18 * mean) * 10) / 10;
}

export interface PublishedScoreHint {
  /** Média normalizada 0..100 (escala do radar do nexus_model_ranking). */
  readonly score100: number;
  /** Proveniência: quais números publicados geraram a estimativa. */
  readonly label: string;
}

const PUBLISHED_METRIC_LABELS = {
  deepSWE: 'DeepSWE',
  terminalBench21: 'TB2.1',
  swebenchVerified: 'SWE-bench',
} as const;

/**
 * Estimativa 0..100 para o radar a partir dos benchmarks publicados
 * (F-1290): a mesma média do `publishedCodingQuality`, na escala do fixture.
 * `null` quando não há número publicado — sem número, sem linha (a regra do
 * "sem publicação" do F-675 continua valendo: qwen e Cia. seguem de fora).
 */
export function publishedScoreHint(
  adapterId: string,
  model: string,
): PublishedScoreHint | null {
  const entry = publishedBenchmarkFor(adapterId, model);
  if (!entry) return null;
  const mean = publishedNormalizedMean(entry);
  if (mean === null) return null;
  const parts: string[] = [];
  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const value = entry[key];
    if (typeof value === 'number') {
      parts.push(
        `${PUBLISHED_METRIC_LABELS[key]} ${String(value).replace('.', ',')}`,
      );
    }
  }
  if (parts.length === 0) return null;
  return {
    score100: Math.round(mean * 1000) / 10,
    label: `estimativa de benchmark publicado (${parts.join(' · ')})`,
  };
}
