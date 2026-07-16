// Vendored/derived from can1357/oh-my-pi@03c48d073 (MIT)
/**
 * Identidade de modelo: classifica um modelId em família/variante/versão.
 *
 * Módulo próprio derivado de `packages/catalog/src/identity/` do oh-my-pi
 * (classify.ts + markers.ts). O diretório original não foi vendorado inteiro
 * porque `bundled.ts`/`reference.ts` acoplam em `../models` (o loader do
 * catálogo completo de 1.8MB); aqui vive só o essencial que o Nexus usa:
 * parse de família (anthropic/openai/glm/gemini), strip de namespace e strip
 * de marcadores de sufixo que não mudam a identidade do modelo.
 */

export interface ModelSemVer {
  major: number;
  minor: number;
  patch: number;
}

export type AnthropicKind = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
export type OpenAIVariant =
  | 'base'
  | 'codex'
  | 'codex-max'
  | 'codex-mini'
  | 'codex-spark'
  | 'mini'
  | 'max'
  | 'nano';
export type GlmVariant = 'base' | 'air' | 'turbo' | 'flash' | 'flashx' | 'preview';
export type GeminiKind = 'pro' | 'flash';

export interface AnthropicModelIdentity {
  family: 'anthropic';
  kind: AnthropicKind;
  version: ModelSemVer;
}

export interface OpenAIModelIdentity {
  family: 'openai';
  variant: OpenAIVariant;
  version: ModelSemVer;
}

export interface GlmModelIdentity {
  family: 'glm';
  variant: GlmVariant;
  /** SKU de visão — o `v` colado na versão (`glm-4.5v`). */
  vision: boolean;
  version: ModelSemVer;
}

export interface GeminiModelIdentity {
  family: 'gemini';
  kind: GeminiKind;
  version: ModelSemVer;
}

export interface UnknownModelIdentity {
  family: 'unknown';
  id: string;
}

export type ModelIdentity =
  | AnthropicModelIdentity
  | OpenAIModelIdentity
  | GlmModelIdentity
  | GeminiModelIdentity
  | UnknownModelIdentity;

/** Remove o namespace de provider (`openai/gpt-5.4` → `gpt-5.4`). */
export function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash !== -1 ? modelId.slice(slash + 1) : modelId;
}

/** Versões de modelo são curtas (`4`, `4.5`, `4-5`); nada de semver completo. */
export function parseModelSemVer(version: string): ModelSemVer | null {
  const match = /^(\d{1,2})(?:[.-](\d{1,2}))?(?:[.-](\d{1,2}))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** Claude em qualquer ordem de segmentos: `claude-sonnet-4-5` ou `claude-4-5-sonnet`. */
export function parseAnthropicModelId(modelId: string): AnthropicModelIdentity | null {
  const id = bareModelId(modelId).toLowerCase();
  const kindFirst = /claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2}(?:[.-]\d{1,2}){0,2})\b/.exec(id);
  const versionFirst = kindFirst
    ? null
    : /claude-(\d{1,2}(?:[.-]\d{1,2}){0,2})-(opus|sonnet|haiku|fable|mythos)\b/.exec(id);
  const kind = kindFirst?.[1] ?? versionFirst?.[2];
  const versionInput = kindFirst?.[2] ?? versionFirst?.[1];
  if (!kind || !versionInput) return null;
  const version = parseModelSemVer(versionInput);
  if (!version) return null;
  return { family: 'anthropic', kind: kind as AnthropicKind, version };
}

/** GPT `gpt-<versão>[-variante]`: `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.5`. */
export function parseOpenAIModelId(modelId: string): OpenAIModelIdentity | null {
  const id = bareModelId(modelId).toLowerCase();
  const match =
    /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|mini|max|nano))?\b/.exec(id);
  if (!match) return null;
  const version = parseModelSemVer(match[1]);
  if (!version) return null;
  return {
    family: 'openai',
    variant: (match[2] as OpenAIVariant | undefined) ?? 'base',
    version,
  };
}

/** GLM `glm-<versão>[v][-variante]`: `glm-4.5-air`, `glm-5-turbo`, `glm-4.5v`. */
export function parseGlmModelId(modelId: string): GlmModelIdentity | null {
  const id = bareModelId(modelId).toLowerCase();
  const match = /glm-(\d{1,2}(?:\.\d+)?)(v)?(?:-(air|turbo|flashx|flash|preview))?\b/.exec(id);
  if (!match) return null;
  const version = parseModelSemVer(match[1]);
  if (!version) return null;
  return {
    family: 'glm',
    variant: (match[3] as GlmVariant | undefined) ?? 'base',
    vision: match[2] === 'v',
    version,
  };
}

/** Gemini `gemini-<versão>-(pro|flash)`, ignorando o sufixo `-preview`. */
export function parseGeminiModelId(modelId: string): GeminiModelIdentity | null {
  let id = bareModelId(modelId).toLowerCase();
  if (id.endsWith('-preview')) id = id.slice(0, -'-preview'.length);
  const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(id);
  if (!match) return null;
  const version = parseModelSemVer(match[1]);
  if (!version) return null;
  return { family: 'gemini', kind: match[2] as GeminiKind, version };
}

/** Classifica um modelId em família conhecida; `unknown` preserva o id "bare". */
export function classifyModelId(modelId: string): ModelIdentity {
  return (
    parseAnthropicModelId(modelId) ??
    parseGeminiModelId(modelId) ??
    parseGlmModelId(modelId) ??
    parseOpenAIModelId(modelId) ?? { family: 'unknown', id: bareModelId(modelId) }
  );
}

/**
 * Marcadores de sufixo que NÃO mudam a identidade do modelo — roteamento,
 * esforço de thinking e datas de snapshot (subconjunto do markers.ts do omp
 * relevante aos adapters do Nexus). `-fast`/`-search` ficam de fora de
 * propósito: mudam a identidade (`grok-4-fast` ≠ `grok-4`).
 */
const TRAILING_MARKER_PATTERN =
  /[-:](?:thinking|latest|minimal|low|medium|high|xhigh|\d{8})$/i;

/**
 * Remove UM marcador de sufixo por chamada (`claude-opus-4-6-thinking` →
 * `claude-opus-4-6`). Retorna null quando não há marcador para remover —
 * o chamador itera até esgotar.
 */
export function stripTrailingMarker(modelId: string): string | null {
  const match = TRAILING_MARKER_PATTERN.exec(modelId);
  if (!match) return null;
  return modelId.slice(0, modelId.length - match[0].length);
}
