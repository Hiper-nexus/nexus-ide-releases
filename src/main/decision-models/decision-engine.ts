/**
 * Roteador custo×qualidade do Automático (F-1165, policyVersion v2).
 *
 * Só decide no modo `auto`. Modelo pedido pelo chamador e surfaces fixas no
 * Jev continuam na política v1 (`resolveDecisionRoute`), sem mudança. Para as
 * demais: perfil da surface (modalidade, criticidade, latência) → candidatos
 * com credencial que atendem a modalidade → pontuação qualidade − λ·custo.
 * Acima do limiar suave do orçamento: só o mais barato elegível, sem ensemble.
 * Surfaces com limiar calibrado no Jev ficam nele quando é elegível e o
 * orçamento é normal; clef-flash e Luna vão em `fallbacks`. O disjuntor é do juiz.
 */
import {
  hasAudioRecipientConsent, hasVisionRecipientConsent, LUNA_DECISION_MODEL,
  type DecisionProvider, type DecisionRoute, type DecisionSettings,
} from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import type { DecisionBudgetLevel } from './decision-budget';
import { decisionInputUsdPerMillion, estimateDecisionCostUsd, estimateDecisionInputTokens } from './decision-pricing';
import { decisionLatencyPenalty, decisionQuality, decisionThinSamplePenalty, MIN_QUALITY_CASES, type DecisionModelKey, type DecisionQualityTable, type QualityModality } from './decision-quality';
import {
  CALIBRATED_THRESHOLD_SURFACES, JEV_PINNED_SURFACES, REVERSIBLE_ENSEMBLE_SURFACES, SECURITY_ENSEMBLE_SURFACES,
  resolveDecisionRoute, jevModel, type DecisionAvailability,
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

/** Surfaces que seguram o operador, o hook ou o spawn: latência curta. */
const INTERACTIVE_SURFACES: ReadonlySet<string> = new Set([
  'intake', 'delegation', 'paneState', 'toolPick', 'judgeTool', 'wakeConfirm', 'terminalTriage', 'helperReuse',
  'taskRouting',
]);
const INTERACTIVE_LATENCY_MS = 5_000;
/** F-1166: surfaces consultivas de fase — disparadas fora do caminho crítico, prazo curto. */
export const ADVISORY_SURFACES: ReadonlySet<string> = new Set(['missionKickoff', 'reviewTriage', 'recoveryAdvice', 'completionCheck']);
export const ADVISORY_LATENCY_MS = 8_000;
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
    latencyBudgetMs: surface && INTERACTIVE_SURFACES.has(surface) ? INTERACTIVE_LATENCY_MS
      : surface && ADVISORY_SURFACES.has(surface) ? ADVISORY_LATENCY_MS : BACKGROUND_LATENCY_MS,
  };
}

export interface DecisionCandidate {
  key: DecisionModelKey; provider: DecisionProvider; model: string;
  quality: number; source: 'local-evaluation' | 'blended' | 'prior'; usdPerMillion: number; score: number; p50Ms: number | null;
  /** Casos medidos na PRÓPRIA surface (o ensemble exige ≥ MIN_QUALITY_CASES nos dois membros). */
  surfaceCases: number;
}

function providerOf(key: DecisionModelKey): DecisionProvider {
  return key === 'jev' ? 'jev' : key === 'luna' ? 'luna' : 'clef';
}

function modelIdOf(key: DecisionModelKey, selectedJevModel: string): string {
  return key === 'jev' ? selectedJevModel : key === 'luna' ? LUNA_DECISION_MODEL : key;
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
  table: DecisionQualityTable | null, lambda = DECISION_COST_LAMBDA, selectedJevModel = process.env.NEXUS_JEV_MODEL ?? 'jev-latest',
): DecisionCandidate[] {
  const all = keys.map((key): DecisionCandidate => {
    const provider = providerOf(key);
    // Versionless historical Jev measurements cannot certify a different model.
    const estimate = decisionQuality(key === 'jev' && selectedJevModel !== 'jev-latest' && selectedJevModel !== 'jev-1.13.0' ? null : table, surface, key, profile.modality);
    const usdPerMillion = decisionInputUsdPerMillion(provider, key === 'luna' ? LUNA_DECISION_MODEL : key);
    const score = estimate.quality - lambda * usdPerMillion
      - decisionLatencyPenalty(estimate.p50Ms, profile.latencyBudgetMs)
      - decisionThinSamplePenalty(estimate.source, estimate.surfaceCases);
    return { key, provider, model: modelIdOf(key, selectedJevModel), quality: estimate.quality, source: estimate.source,
      usdPerMillion, score, p50Ms: estimate.p50Ms, surfaceCases: estimate.surfaceCases };
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
  /** Próximo provedor quando o primário falha ou o disjuntor dele está aberto. Um por provedor. */
  fallbacks?: DecisionRoute[];
  estimatedTokens: number;
  estimatedUsd: number;
}

/** clef-flash representa o Clef; o cheio e o omni não duplicam o mesmo provedor. */
function decisionFallbacks(primary: DecisionCandidate, pool: readonly DecisionCandidate[], reason: string): DecisionRoute[] {
  const order: DecisionProvider[] = primary.provider === 'jev'
    ? ['clef', 'luna']
    : (['jev', 'clef', 'luna'] as const).filter(provider => provider !== primary.provider);
  const routes: DecisionRoute[] = [];
  for (const provider of order) {
    const matches = pool.filter(candidate => candidate.provider === provider);
    const candidate = provider === 'clef' ? matches.find(item => item.key === 'clef-flash') ?? matches[0] : matches[0];
    if (candidate) routes.push(v2Route(candidate, reason));
  }
  return routes;
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
    options.quality, options.lambda, jevModel(settings));
  if (!ranked.length) {
    // Sem candidato no v2: a política v1 ainda decide (e o diário tem a linha da consulta).
    const route = resolveDecisionRoute(input, settings, available);
    return route ? { route, estimatedTokens: tokens, estimatedUsd: estimateDecisionCostUsd(tokens, route.provider, route.model) } : null;
  }
  const soft = options.budgetLevel !== 'normal';
  const rankedWinner = soft
    ? [...ranked].sort((a, b) => a.usdPerMillion - b.usdPerMillion || b.quality - a.quality)[0]
    : ranked[0];
  const calibrated = Boolean(input.surface && CALIBRATED_THRESHOLD_SURFACES.has(input.surface));
  // O disjuntor não entra aqui: plano saudável, e o juiz pula quem estiver aberto.
  const jevCandidate = !soft && calibrated && profile.modality === 'text'
    ? ranked.find(candidate => candidate.provider === 'jev') : undefined;
  const chosen = jevCandidate ?? rankedWinner;
  const header = `auto v2 · ${input.surface ?? 'sem surface'} (${profile.modality}, ${profile.criticality})`;
  const budgetNote = soft ? 'orçamento acima de 80%: o mais barato' : 'orçamento normal';
  const alternatives = ranked.filter(candidate => candidate !== chosen).slice(0, 3)
    .map(candidate => `${candidate.key} ${fmt(candidate.score)}`).join(', ');
  const evidenceLabel = chosen.source === 'prior' ? 'prior' : chosen.source === 'blended' ? 'prior + medição global' : 'avaliação local';
  const why = `${chosen.key} q=${fmt(chosen.quality)} (${evidenceLabel}) `
    + `US$ ${chosen.usdPerMillion}/M → ${fmt(chosen.score)}`;
  // "Usar várias": segurança/reversível, texto, orçamento normal, 2+ provedores e nenhum sozinho confiável.
  // Limiar calibrado é a distribuição de um provedor: não mistura respostas.
  if (!soft && !calibrated && profile.modality === 'text' && profile.criticality !== 'normal' && chosen.quality < ENSEMBLE_QUALITY_CEILING) {
    const perProvider: DecisionCandidate[] = [];
    for (const candidate of ranked) {
      if (!perProvider.some(member => member.provider === candidate.provider)) perProvider.push(candidate);
    }
    const pair = perProvider.slice(0, 2);
    // Só com medição DA PRÓPRIA surface (≥ MIN_QUALITY_CASES) nos dois membros: a global misturada não liga ensemble.
    if (pair.length >= 2 && pair.every(member => member.source === 'local-evaluation' && member.surfaceCases >= MIN_QUALITY_CASES)) {
      const reason = `${header} · usar várias: ${pair.map(member => `${member.key} ${fmt(member.score)}`).join(' + ')}`
        + ` (melhor sozinho q=${fmt(chosen.quality)} < ${ENSEMBLE_QUALITY_CEILING}) · ${budgetNote}`;
      const members = pair.map(member => v2Route(member, reason));
      return { route: members[0], members, estimatedTokens: tokens,
        estimatedUsd: pair.reduce((sum, member) => sum + estimateDecisionCostUsd(tokens, member.provider, member.key === 'luna' ? LUNA_DECISION_MODEL : member.key), 0) };
    }
  }
  const calibratedNote = jevCandidate && jevCandidate !== rankedWinner ? ' · limiar calibrado no Jev' : '';
  const reason = `${header} · ${why}${calibratedNote}${alternatives ? ` · alternativas: ${alternatives}` : ''} · ${budgetNote}`;
  const fallbacks = calibrated && profile.modality === 'text' ? decisionFallbacks(chosen, ranked, reason) : [];
  return { route: v2Route(chosen, reason), ...(fallbacks.length ? { fallbacks } : {}), estimatedTokens: tokens,
    estimatedUsd: estimateDecisionCostUsd(tokens, chosen.provider, chosen.key === 'luna' ? LUNA_DECISION_MODEL : chosen.key) };
}
