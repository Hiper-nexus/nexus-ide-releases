/**
 * Resolve rótulos compactos de LLM/versão para o chip da toolbar do pane.
 * Fonte canônica: pane.adapterId + pane.model + pane.effort — sem IPC, sem async.
 * Regra: nunca inventa modelo. Se adapterId não for reconhecido retorna null
 * (pane de shell puro).
 *
 * Testes co-located: pane-model-label.test.ts
 */

/** Mapeamento de prefixo/sufixo do adapterId → nome de família exibível. */
const FAMILY_MAP: readonly [pattern: string, family: string][] = [
  // Strings mais longas primeiro para o prefix-match preferir o mais específico.
  ['cursor-grok', 'Grok'],
  ['cursor-agent', 'Cursor'],
  ['prime-agent', 'Prime'],
  ['minimax-code', 'MiniMax'],
  ['openai-codex', 'GPT'],
  ['claude-code', 'Claude'],
  ['opencode', 'OpenCode'],
  ['longcat', 'LongCat'],
  ['deepseek', 'DeepSeek'],
  ['sakana', 'Sakana'],
  ['qoder', 'Qoder'],
  ['claude', 'Claude'],
  ['codex', 'GPT'],
  ['grok', 'Grok'],
  ['kimi', 'Kimi'],
  ['qwen', 'Qwen'],
  ['glm', 'GLM'],
  ['aider', 'Aider'],
  ['muse', 'Muse'],
  ['minimax', 'MiniMax'],
  ['omp', 'OMP'],
  ['agy', 'AGY'],
];

const EFFORT_LABELS: Readonly<Record<string, { abbr: string; label: string }>> = {
  high: { abbr: 'H', label: 'High' },
  xhigh: { abbr: 'XH', label: 'XHigh' },
  medium: { abbr: 'M', label: 'Medium' },
  med: { abbr: 'M', label: 'Medium' },
  low: { abbr: 'L', label: 'Low' },
  mini: { abbr: 'Mi', label: 'Mini' },
};

export function familyFromAdapterId(adapterId: string): string | null {
  const lower = adapterId.toLowerCase();
  // Exact match first
  for (const [pattern, family] of FAMILY_MAP) {
    if (lower === pattern) return family;
  }
  // Prefix match ("cursor-grok-4.5-high" → "cursor-grok" → "Grok")
  for (const [pattern, family] of FAMILY_MAP) {
    if (lower.startsWith(pattern + '-') || lower.startsWith(pattern + ':')) {
      return family;
    }
  }
  return null;
}

/** Título capitalizado de uma parte do ID: "sonnet" → "Sonnet". */
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * Extrai versão humanizada do model ID já sem o prefixo de família.
 * "sonnet-4-5" → "Sonnet 4.5", "3.1-pro" → "3.1 Pro", "v4-pro" → "V4 Pro"
 *
 * Partes numéricas consecutivas ("4", "5") são unidas com ponto ("4.5");
 * partes-palavra são capitalizadas e separadas por espaço.
 */
function normalizeVersionParts(parts: string[]): string {
  const filtered = parts.filter((p) => !EFFORT_LABELS[p.toLowerCase()]);
  const result: string[] = [];
  const numBuf: string[] = [];

  const flushNum = () => {
    if (numBuf.length > 0) {
      result.push(numBuf.join('.'));
      numBuf.length = 0;
    }
  };

  for (const part of filtered) {
    if (/^\d+$/.test(part)) {
      numBuf.push(part);
    } else {
      flushNum();
      result.push(cap(part));
    }
  }
  flushNum();

  return result.join(' ');
}

interface ParsedModel {
  version: string;
  /** Effort keyword encontrado dentro do próprio model ID (ex: "gpt-5.6-luna-medium"). */
  effortInModel?: string;
}

function parseModelVersion(model: string): ParsedModel {
  // Sufixos de rota entre colchetes (`glm-5.3-flash[1m]` = variante 1M da
  // z.ai) são detalhe de endpoint — o chip mostra o nome limpo, como o
  // `%%[*` do launcher.
  const clean = model.replace(/\[[^\]]*\]/g, '');
  const lower = clean.toLowerCase();

  // GPT: "gpt-5.6-luna-medium" → ver "5.6 Luna", effort "medium"
  //      "gpt-5.6-sol-medium" → ver "5.6 Sol", effort "medium"
  if (lower.startsWith('gpt-')) {
    const parts = clean.slice(4).split('-');
    const effortIdx = parts.findIndex((p) => EFFORT_LABELS[p.toLowerCase()]);
    const vParts =
      effortIdx >= 0 ? parts.slice(0, effortIdx) : parts;
    const eParts =
      effortIdx >= 0 ? [parts[effortIdx]!.toLowerCase()] : [];
    return {
      version: normalizeVersionParts(vParts),
      effortInModel: eParts[0],
    };
  }

  // Claude: "claude-sonnet-4-5" → "Sonnet 4.5"
  if (lower.startsWith('claude-')) {
    const parts = clean.slice(7).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // Gemini: "gemini-3.1-pro" → "3.1 Pro"
  if (lower.startsWith('gemini-')) {
    const parts = clean.slice(7).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // DeepSeek: "deepseek-v4-pro" → "V4 Pro"
  if (lower.startsWith('deepseek-')) {
    const parts = clean.slice(9).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // Grok: "grok-4.5" | "cursor-grok-4.5-high"
  if (lower.startsWith('cursor-grok-')) {
    return parseGrokSuffix(clean.slice(12));
  }
  if (lower.startsWith('grok-')) {
    return parseGrokSuffix(clean.slice(5));
  }

  // Kimi: "kimi-code/k3" → "K3", "kimi-k3-max" → "K3 Max", "kimi-k2.8" → "K2.8"
  if (lower.startsWith('kimi-code/')) {
    const parts = clean.slice(10).split('-');
    return { version: normalizeVersionParts(parts) };
  }
  if (lower.startsWith('kimi-')) {
    const parts = clean.slice(5).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // GLM: "glm-4-pro" → "4 Pro"
  if (lower.startsWith('glm-')) {
    const parts = clean.slice(4).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // Muse: "muse-spark-1.3" → "Spark 1.3", "muse-wonder-full-1.0" →
  // "Wonder Full 1.0" (F-1391).
  // O placeholder "muse" (id do adapter) não é modelo — versão vazia.
  if (lower === 'muse') {
    return { version: '' };
  }
  if (lower.startsWith('muse-')) {
    const parts = clean.slice('muse-'.length).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // Qwen: "qwen2.5-coder" → "2.5 Coder"
  if (lower.startsWith('qwen')) {
    const parts = clean.slice(4).split('-');
    return { version: normalizeVersionParts(parts) };
  }

  // MiniMax Code: "minimax/MiniMax-M3.1-Flash-Preview" → "M3.1 Flash Preview"
  if (lower.startsWith('minimax/')) {
    const id = clean.slice('minimax/'.length).replace(/^minimax-/i, '');
    return { version: normalizeVersionParts(id.split('-')) };
  }

  // Fallback genérico: retorna o model como está
  return { version: clean };
}

function parseGrokSuffix(suffix: string): ParsedModel {
  const parts = suffix.split('-');
  const effortIdx = parts.findIndex((p) => EFFORT_LABELS[p.toLowerCase()]);
  const vParts = effortIdx >= 0 ? parts.slice(0, effortIdx) : parts;
  const eParts = effortIdx >= 0 ? [parts[effortIdx]!.toLowerCase()] : [];
  return {
    version: normalizeVersionParts(vParts),
    effortInModel: eParts[0],
  };
}

export interface PaneModelLabel {
  /** "Claude", "GPT", "Gemini", "Grok", "Kimi", "DeepSeek" */
  family: string;
  /** "Sonnet 4.5", "5.5", "3.1 Pro", "" quando desconhecida */
  version: string;
  /** "H", "M", "XH" — undefined quando esforço não é conhecido */
  effortAbbr?: string;
  /**
   * Ultra-compacto (pane < ~260px): só a família.
   * Ex.: "Claude" | "GPT" | "Gemini"
   */
  compact: string;
  /**
   * Médio (pane < ~380px): família + primeiro segmento de versão.
   * Ex.: "Claude Sonnet" | "GPT 5.5" | "Gemini 3.1"
   */
  medium: string;
  /**
   * Texto completo para tooltip (title nativo).
   * Ex.: "Claude Sonnet 4.5 · High" | "GPT 5.5 · Medium" | "Gemini 3.1 Pro"
   */
  full: string;
}

/**
 * Resolve rótulos de LLM/versão a partir dos campos canônicos do pane.
 * Retorna null para panes sem adapterId reconhecido (shells puros, etc.).
 */
export function resolveModelChipLabel(
  adapterId: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): PaneModelLabel | null {
  if (!adapterId) return null;

  const family = familyFromAdapterId(adapterId);
  if (!family) return null;

  let version = '';
  let effortFromModel: string | undefined;

  if (model) {
    const parsed = parseModelVersion(model);
    version = parsed.version;
    effortFromModel = parsed.effortInModel;
  }

  const effortKey = (effort ?? effortFromModel ?? '').toLowerCase().trim();
  const effortInfo = effortKey ? EFFORT_LABELS[effortKey] : undefined;

  // medium: família + primeiro segmento da versão (antes do primeiro espaço)
  const versionHead = version.split(' ')[0] ?? '';
  const medium = versionHead ? `${family} ${versionHead}` : family;

  // full: família + versão completa + esforço
  const versionFull = version ? `${family} ${version}` : family;
  const full = effortInfo ? `${versionFull} · ${effortInfo.label}` : versionFull;

  return {
    family,
    version,
    effortAbbr: effortInfo?.abbr,
    compact: family,
    medium,
    full,
  };
}
