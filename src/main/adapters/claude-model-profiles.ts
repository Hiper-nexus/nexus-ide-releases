// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: dados de
// apps/server/src/provider/model-manifest.json (providers.claudeAgent) e a
// lógica de ClaudeModelCatalog.ts/ClaudeModelManifest.ts em TS puro (sem
// Effect/Schema); só os níveis que a CLI recebe em `--effort` (sem ultracode,
// ultrathink e fastMode, opções de UI do T3); aliases sem família nua (`opus`,
// `sonnet`, `haiku`, `fable` mudam de alvo com a versão da CLI); opus-4-5 sem
// `max` e sonnet-4-5 sem esforço, como a CLI 2.1.283/2.1.293 decide; versão
// abaixo do mínimo só avisa — nunca esconde o modelo.
import type { ModelCatalogEntryInfo } from '../../shared/adapter-types';
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

interface ClaudeProfile {
  /** Níveis aceitos por este modelo. Vazio: o modelo não tem esforço. */
  readonly efforts: readonly ClaudeEffort[];
  readonly defaultEffort?: ClaudeEffort;
  /** Nível pedido → nível entregue à CLI; `null` tira o `--effort`. */
  readonly effortMap?: Readonly<Partial<Record<ClaudeEffort, ClaudeEffort | null>>>;
  /** Janela do id sem sufixo, quando o manifesto a documenta. */
  readonly contextWindowTokens?: number;
  /** O id com `[1m]` abre a janela de 1M (opus-4-6, sonnet-4-6). */
  readonly oneMillionSuffix?: boolean;
}

interface ClaudeModelEntry {
  readonly slug: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly profile: keyof typeof PROFILES;
  /** Primeira versão da CLI que conhece o modelo (manifesto do T3). */
  readonly minVersion?: string;
}

const ALL = CLAUDE_EFFORTS;
const ONE_MILLION = 1_000_000;

const PROFILES = {
  'fable-5': { efforts: ALL, defaultEffort: 'medium', contextWindowTokens: ONE_MILLION },
  'opus-5-5': { efforts: ALL, defaultEffort: 'medium', contextWindowTokens: ONE_MILLION },
  'opus-5': { efforts: ALL, defaultEffort: 'high', contextWindowTokens: ONE_MILLION },
  'opus-4-8': { efforts: ALL, defaultEffort: 'high', contextWindowTokens: ONE_MILLION },
  'opus-4-7': {
    efforts: ALL,
    defaultEffort: 'xhigh',
    effortMap: { xhigh: 'max' },
    contextWindowTokens: ONE_MILLION,
  },
  'opus-4-6': {
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    contextWindowTokens: 200_000,
    oneMillionSuffix: true,
  },
  'opus-4-5': { efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindowTokens: 200_000 },
  'sonnet-5': { efforts: ALL, defaultEffort: 'high', contextWindowTokens: ONE_MILLION },
  'sonnet-4-6': {
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    effortMap: { max: 'high' },
    contextWindowTokens: 200_000,
    oneMillionSuffix: true,
  },
  'sonnet-4-5': { efforts: [] },
  'haiku-5-5': { efforts: ALL, defaultEffort: 'medium', contextWindowTokens: ONE_MILLION },
  'haiku-4-5': { efforts: [], contextWindowTokens: 200_000 },
} as const satisfies Record<string, ClaudeProfile>;

const MODELS: readonly ClaudeModelEntry[] = [
  { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', aliases: ['opus-5.5', 'claude-opus-5.5'], profile: 'opus-5-5', minVersion: '2.1.280' },
  { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', aliases: ['sonnet-5.5', 'claude-sonnet-5.5'], profile: 'sonnet-5', minVersion: '2.1.284' },
  { slug: 'claude-fable-5-1', name: 'Claude Fable 5.1', aliases: ['fable-5.1', 'claude-fable-5.1'], profile: 'fable-5', minVersion: '2.1.257' },
  { slug: 'claude-fable-5', name: 'Claude Fable 5', profile: 'fable-5', minVersion: '2.1.169' },
  { slug: 'claude-opus-5', name: 'Claude Opus 5', aliases: ['opus-5', 'claude-opus-5.0', 'claude-opus-5-0'], profile: 'opus-5', minVersion: '2.1.219' },
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', aliases: ['opus-4.8', 'claude-opus-4.8'], profile: 'opus-4-8', minVersion: '2.1.154' },
  { slug: 'claude-opus-4-7', name: 'Claude Opus 4.7', aliases: ['opus-4.7', 'claude-opus-4.7'], profile: 'opus-4-7', minVersion: '2.1.111' },
  { slug: 'claude-opus-4-6', name: 'Claude Opus 4.6', aliases: ['opus-4.6', 'claude-opus-4.6', 'claude-opus-4-6-20251117'], profile: 'opus-4-6' },
  { slug: 'claude-opus-4-5', name: 'Claude Opus 4.5', profile: 'opus-4-5' },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', aliases: ['sonnet-5', 'claude-sonnet-5.0', 'claude-sonnet-5-0'], profile: 'sonnet-5' },
  { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', aliases: ['sonnet-4.6', 'claude-sonnet-4.6', 'claude-sonnet-4-6-20251117'], profile: 'sonnet-4-6' },
  { slug: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', aliases: ['claude-sonnet-4-5-20250929'], profile: 'sonnet-4-5' },
  { slug: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', aliases: ['haiku-5.5', 'claude-haiku-5.5'], profile: 'haiku-5-5', minVersion: '2.1.293' },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', aliases: ['haiku-4.5', 'claude-haiku-4.5', 'claude-haiku-4-5-20251001'], profile: 'haiku-4-5' },
];

const ONE_MILLION_SUFFIX = /\[1m\]$/i;

interface ResolvedClaudeModel {
  readonly entry: ClaudeModelEntry;
  readonly profile: ClaudeProfile;
  readonly oneMillion: boolean;
}

/** Slug, alias com versão ou id com `[1m]`; família nua e id alheio → null. */
export function resolveClaudeModel(model: string | null | undefined): ResolvedClaudeModel | null {
  const raw = model?.trim();
  if (!raw) return null;
  const oneMillion = ONE_MILLION_SUFFIX.test(raw);
  const value = raw.replace(ONE_MILLION_SUFFIX, '').toLowerCase();
  const entry =
    MODELS.find((candidate) => candidate.slug === value) ??
    MODELS.find((candidate) => candidate.aliases?.some((alias) => alias.toLowerCase() === value));
  if (!entry) return null;
  return { entry, profile: PROFILES[entry.profile], oneMillion };
}

/**
 * Esforço que a CLI recebe para este modelo (T3 `resolveClaudeCatalogEffort`
 * + `normalizeClaudeCatalogEffort`): fora da lista do modelo vira o padrão
 * dele, depois passa pelo `effortMap`. `undefined` = sem `--effort`. Modelo
 * fora do catálogo passa intacto.
 */
export function claudeEffortForModel(
  model: string | null | undefined,
  effort: string | null | undefined,
): string | undefined {
  const requested = effort?.trim();
  if (!requested) return undefined;
  const resolved = resolveClaudeModel(model);
  if (!resolved) return requested;
  const { efforts, defaultEffort, effortMap } = resolved.profile;
  const supported = (efforts as readonly string[]).includes(requested)
    ? (requested as ClaudeEffort)
    : defaultEffort;
  if (!supported) return undefined;
  if (effortMap && Object.prototype.hasOwnProperty.call(effortMap, supported)) {
    return effortMap[supported] ?? undefined;
  }
  return supported;
}

/** Reescreve (ou tira) cada `--effort X` / `--effort=X` do argv para o modelo. */
export function claudeEffortArgsForModel(
  args: readonly string[],
  flag: string,
  model: string | null | undefined,
): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = arg.startsWith(`${flag}=`);
    if (arg !== flag && !inline) {
      out.push(arg);
      continue;
    }
    const requested = inline ? arg.slice(flag.length + 1) : args[index + 1];
    if (!inline) index += 1;
    const effort = claudeEffortForModel(model, requested);
    if (effort) out.push(...(inline ? [`${flag}=${effort}`] : [flag, effort]));
  }
  return out;
}

/** Janela documentada do id (com `[1m]` quando o perfil aceita o sufixo). */
export function claudeModelContextWindow(model: string | null | undefined): number | undefined {
  const resolved = resolveClaudeModel(model);
  if (!resolved) return undefined;
  if (resolved.oneMillion && resolved.profile.oneMillionSuffix) return ONE_MILLION;
  return resolved.profile.contextWindowTokens;
}

/**
 * Versão da CLI abaixo do mínimo do modelo (T3
 * `formatClaudeVersionUpgradeMessage`, por modelo). Só aviso: o pane abre
 * igual, e só a recusa real da CLI (detector de modelo recusado + quarentena)
 * tira o modelo da rota. Versão desconhecida não avisa.
 */
export function claudeModelVersionWarning(
  model: string | null | undefined,
  version: string | null | undefined,
): string | undefined {
  const minVersion = resolveClaudeModel(model)?.entry.minVersion;
  if (!minVersion || !version || !isValidAppVersion(version)) return undefined;
  if (compareAppVersions(version, minVersion) >= 0) return undefined;
  const name = resolveClaudeModel(model)!.entry.name;
  return (
    `Claude Code v${version} é anterior à v${minVersion}, a primeira que conhece o ${name}. ` +
    `O pane abre assim mesmo; se a CLI recusar o modelo, atualize: claude update.`
  );
}

/** Campos do perfil para o catálogo (só os ausentes na entrada). */
export function withClaudeModelProfile(entry: ModelCatalogEntryInfo): ModelCatalogEntryInfo {
  const resolved = resolveClaudeModel(entry.id);
  if (!resolved) return entry;
  const maxContext = claudeModelContextWindow(entry.id);
  return {
    ...entry,
    ...(entry.efforts === undefined ? { efforts: [...resolved.profile.efforts] } : {}),
    ...(entry.minCliVersion === undefined && resolved.entry.minVersion
      ? { minCliVersion: resolved.entry.minVersion }
      : {}),
    ...(entry.maxContext === undefined && maxContext !== undefined ? { maxContext } : {}),
  };
}
