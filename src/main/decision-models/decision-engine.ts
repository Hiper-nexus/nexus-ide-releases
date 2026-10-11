/**
 * Roteador custo×qualidade do Automático (F-1165, policyVersion v2).
 *
 * Só decide no modo `auto`. Modelo pedido pelo chamador e surfaces fixas no
 * Jev continuam na política v1 (`resolveDecisionRoute`), sem mudança. Para as
 * demais: perfil da surface (modalidade, criticidade, latência) → candidatos
 * com credencial que atendem a modalidade → pontuação qualidade − λ·custo.
 * Acima do limiar suave do orçamento: só o mais barato elegível, sem ensemble.
 */
import {
  hasAudioRecipientConsent, hasVisionRecipientConsent, LUNA_DECISION_MODEL,
  type DecisionProvider, type DecisionRoute, type DecisionSettings,
} from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import type { DecisionBudgetLevel } from './decision-budget';
import { decisionInputUsdPerMillion, estimateDecisionCostUsd, estimateDecisionInputTokens } from './decision-pricing';
import { decisionQuality, type DecisionModelKey, type DecisionQualityTable, type QualityModality } from './decision-quality';
import {
  JEV_PINNED_SURFACES, REVERSIBLE_ENSEMBLE_SURFACES, SECURITY_ENSEMBLE_SURFACES,
  resolveDecisionRoute, type DecisionAvailability,
} from './decision-routing';

export const DECISION_ENGINE_POLICY = 'decision-engine-v2' as const;
/** Peso do custo: λ por US$/milhão de tokens de entrada. */
export const DECISION_COST_LAMBDA = 0.5;
/**
 * "Usar várias" só quando nenhum modelo sozinho é confiável o bastante — e só
 * com qualidade MEDIDA localmente (nunca com prior: os priors ficam todos
 * abaixo do teto e ligariam o ensemble em toda surface reversível).
 */
export const ENSEMBLE_QUALITY_CEILING = 0.9;

export type DecisionCriticality = 'security' | 'reversible' | 'normal';
export interface DecisionSurfaceProfile {
  modality: QualityModality;
  criticality: DecisionCriticality;
  latencyBudgetMs: number;
}

/** Surfaces que seguram o operador ou o hook: latência curta. */
const INTERACTIVE_SURFACES: ReadonlySet<string> = new Set([
  'intake', 'delegation', 'paneState', 'toolPick', 'judgeTool', 'wakeConfirm', 'terminalTriage', 'helperReuse',
]);
const INTERACTIVE_LATENCY_MS = 5_000;
const BACKGROUND_LATENCY_MS = 15_000;

type EngineInput = Pick<JudgeInput, 'surface' | 'model' | 'images' | 'audio' | 'audioRequired' | 'state' | 'questions'>;

function audioReady(input: EngineInput, settings: DecisionSettings, available: DecisionAvailability): boolean {
  return Boolean(input.audio?.length) && hasAudioRecipientConsent(settings, 'clef') && available.clef;
}

export function decisionSurfaceProfile(
  input: EngineInput, settings: DecisionSettings, available: DecisionAvailability,
): DecisionSurfaceProfile {
  const surface = input.surface;
  return {
    modality: input.images?.length ? 'image' : audioReady(input, settings, available) ? 'audio' : 'text',
    criticality: surface && SECURITY_ENSEMBLE_SURFACES.has(surface) ? 'security'
      : surface && REVERSIBLE_ENSEMBLE_SURFACES.has(surface) ? 'reversible' : 'normal',
    latencyBudgetMs: surface && INTERACTIVE_SURFACES.has(surface) ? INTERACTIVE_LATENCY_MS : BACKGROUND_LATENCY_MS,
  };
}

export interface DecisionCandidate {
  key: DecisionModelKey; provider: DecisionProvider; model: string;
  quality: number; source: 'local-evaluation' | 'prior'; usdPerMillion: number; score: number; p50Ms: number | null;
}

function providerOf(key: DecisionModelKey): DecisionProvider {
  return key === 'jev' ? 'jev' : key === 'luna' ? 'luna' : 'clef';
}

function modelIdOf(key: DecisionModelKey): string {
  return key === 'jev' ? process.env.NEXUS_JEV_MODEL ?? 'jev-latest' : key === 'luna' ? LUNA_DECISION_MODEL : key;
}

/** Quem tem credencial E atende a modalidade, com o consentimento correspondente. */
export function eligibleDecisionModels(
  profile: DecisionSurfaceProfile, settings: DecisionSettings, available: DecisionAvailability,
): DecisionModelKey[] {
  const luna = available.luna === true;
  if (profile.modality === 'audio') return available.clef && hasAudioRecipientConsent(settings, 'clef') ? ['clef-omni'] : [];
  if (profile.modality === 'image') {
    if (!settings.visionEnabled) return [];
    const keys: DecisionModelKey[] = [];
    if (available.clef && hasVisionRecipientConsent(settings, 'clef')) keys.push('clef-omni', 'clef');
    if (luna && hasVisionRecipientConsent(settings, 'luna')) keys.push('luna');
    return keys;
  }
  const keys: DecisionModelKey[] = [];
  if (available.jev) keys.push('jev');
  if (available.clef) keys.push('clef-flash', 'clef-omni', 'clef');
  if (luna) keys.push('luna');
  return keys;
}

export function scoreDecisionCandidates(
  keys: readonly DecisionModelKey[], surface: string | undefined, profile: DecisionSurfaceProfile,
  table: DecisionQualityTable | null, lambda = DECISION_COST_LAMBDA,
): DecisionCandidate[] {
  const all = keys.map((key): DecisionCandidate => {
    const provider = providerOf(key);
    const estimate = decisionQuality(table, surface, key, profile.modality);
    const usdPerMillion = decisionInputUsdPerMillion(provider, key === 'luna' ? LUNA_DECISION_MODEL : key);
    return { key, provider, model: modelIdOf(key), quality: estimate.quality, source: estimate.source,
      usdPerMillion, score: estimate.quality - lambda * usdPerMillion, p50Ms: estimate.p50Ms };
  });
  // Elegibilidade é credencial + modalidade + consentimento; a qualidade só ordena.
  // Latência medida acima do orçamento da surface tira o candidato — se sobrar alguém.
  const fast = all.filter(candidate => candidate.p50Ms === null || candidate.p50Ms <= profile.latencyBudgetMs);
  const pool = fast.length ? fast : all;
  return pool.sort((a, b) => b.score - a.score || a.usdPerMillion - b.usdPerMillion);
}

export interface AutoDecisionPlan {
  route: DecisionRoute;
  /** Presente = "usar várias": chamadas paralelas, latência do mais lento. */
  members?: DecisionRoute[];
  estimatedTokens: number;
  estimatedUsd: number;
}

function fmt(value: number): string {
  return value.toFixed(3);
}

function v2Route(candidate: DecisionCandidate, reason: string): DecisionRoute {
  return { provider: candidate.provider, model: candidate.model, policyVersion: DECISION_ENGINE_POLICY,
    evidence: candidate.source, reason };
}

/** Plano do Automático. `null` = nenhuma rota (mesmo contrato do v1: a surface cai na regra). */
export function planAutoDecision(
  input: EngineInput, settings: DecisionSettings, available: DecisionAvailability,
  options: { budgetLevel: DecisionBudgetLevel; quality: DecisionQualityTable | null; lambda?: number },
): AutoDecisionPlan | null {
  if (settings.mode !== 'auto') return null;
  const tokens = estimateDecisionInputTokens(input);
  const profile = decisionSurfaceProfile(input, settings, available);
  const pinned = Boolean(input.surface && JEV_PINNED_SURFACES.has(input.surface as JevDecisionSurface));
  // Modelo pedido, surface fixa no Jev, ou clipe obrigatório sem destino: política v1 intacta.
  if (input.model || pinned || (input.audioRequired && profile.modality !== 'audio')) {
    const route = resolveDecisionRoute(input, settings, available);
    return route ? { route, estimatedTokens: tokens, estimatedUsd: estimateDecisionCostUsd(tokens, route.provider, route.model) } : null;
  }
  const ranked = scoreDecisionCandidates(eligibleDecisionModels(profile, settings, available), input.surface, profile,
    options.quality, options.lambda);
  if (!ranked.length) {
    // Sem candidato no v2: a política v1 ainda decide (e o diário tem a linha da consulta).
    const route = resolveDecisionRoute(input, settings, available);
    return route ? { route, estimatedTokens: tokens, estimatedUsd: estimateDecisionCostUsd(tokens, route.provider, route.model) } : null;
  }
  const soft = options.budgetLevel !== 'normal';
  const chosen = soft
    ? [...ranked].sort((a, b) => a.usdPerMillion - b.usdPerMillion || b.quality - a.quality)[0]
    : ranked[0];
  const header = `auto v2 · ${input.surface ?? 'sem surface'} (${profile.modality}, ${profile.criticality})`;
  const budgetNote = soft ? 'orçamento acima de 80%: o mais barato' : 'orçamento normal';
  const alternatives = ranked.filter(candidate => candidate !== chosen).slice(0, 3)
    .map(candidate => `${candidate.key} ${fmt(candidate.score)}`).join(', ');
  const why = `${chosen.key} q=${fmt(chosen.quality)} (${chosen.source === 'prior' ? 'prior' : 'avaliação local'}) `
    + `US$ ${chosen.usdPerMillion}/M → ${fmt(chosen.score)}`;
  // "Usar várias": segurança/reversível, texto, orçamento normal, 2+ provedores e nenhum sozinho confiável.
  if (!soft && profile.modality === 'text' && profile.criticality !== 'normal' && chosen.quality < ENSEMBLE_QUALITY_CEILING) {
    const perProvider: DecisionCandidate[] = [];
    for (const candidate of ranked) {
      if (!perProvider.some(member => member.provider === candidate.provider)) perProvider.push(candidate);
    }
    const pair = perProvider.slice(0, 2);
    if (pair.length >= 2 && pair.every(member => member.source === 'local-evaluation')) {
      const reason = `${header} · usar várias: ${pair.map(member => `${member.key} ${fmt(member.score)}`).join(' + ')}`
        + ` (melhor sozinho q=${fmt(chosen.quality)} < ${ENSEMBLE_QUALITY_CEILING}) · ${budgetNote}`;
      const members = pair.map(member => v2Route(member, reason));
      return { route: members[0], members, estimatedTokens: tokens,
        estimatedUsd: pair.reduce((sum, member) => sum + estimateDecisionCostUsd(tokens, member.provider, member.key === 'luna' ? LUNA_DECISION_MODEL : member.key), 0) };
    }
  }
  const reason = `${header} · ${why}${alternatives ? ` · alternativas: ${alternatives}` : ''} · ${budgetNote}`;
  return { route: v2Route(chosen, reason), estimatedTokens: tokens,
    estimatedUsd: estimateDecisionCostUsd(tokens, chosen.provider, chosen.key === 'luna' ? LUNA_DECISION_MODEL : chosen.key) };
}
