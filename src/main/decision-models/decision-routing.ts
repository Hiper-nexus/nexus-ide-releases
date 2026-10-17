import { CLEF_MODELS, hasVisionRecipientConsent, LUNA_DECISION_MODEL, visionRecipientsForMode, type DecisionProvider, type DecisionRoute, type DecisionSettings, type ClefModel } from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';

export interface DecisionAvailability { jev: boolean; clef: boolean; luna?: boolean }
export function jevModel(settings: DecisionSettings): string {
  return process.env.NEXUS_JEV_MODEL ?? settings.jevModel ?? 'jev-latest';
}
type RouteInput = Pick<JudgeInput, 'surface' | 'model' | 'images'>;

/**
 * Surfaces that gate or feed an effect (dispatch guard, handoff acceptance,
 * persistent memory, desktop and browser automation). Their thresholds were
 * calibrated against Jev, so Automático, Somente Jev and Somente Clef keep
 * them on Jev (or with no route). Somente Luna and Juntos são escolha do
 * operador e incluem estas superfícies: um pino não ignora essa escolha.
 * Sem a chave da Luna a rota é nula — não volta ao Jev em silêncio.
 */
export const JEV_PINNED_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool', 'taskRouting',
]);

/**
 * Cheap and non-pinned surfaces routed to Clef in auto mode (F-783).
 * Effect-bearing surfaces remain strictly pinned to Jev via JEV_PINNED_SURFACES.
 */
export const CLEF_PREFERRED_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'toolPick',
  'researchTriage',
  'rank',
  'rankTool',
]);

/** Juntos: quem tem chave entra. Sem o Jev, Luna e Clef continuam o conjunto e só apertam entre si. */
export const SECURITY_ENSEMBLE_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'dispatchGuard', 'handoffReview', 'memoryDistill',
]);

/**
 * Automático: superfícies reversíveis elegíveis ao ensemble por qualidade.
 * Juntos inclui taskRouting pela escolha explícita do operador, mesmo fixo no Jev.
 */
export const REVERSIBLE_ENSEMBLE_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'missionPick', 'catalogPick',
]);

/** Juntos: rótulos ficam no Jev. A imagem do navegador é outra chamada. */
const LABEL_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'computerTool', 'browserTool',
]);

export function clefModel(model?: string): ClefModel | undefined {
  const selector = model?.replace('@cf/cloudflare/', '');
  return (CLEF_MODELS as readonly string[]).includes(selector ?? '') ? selector as ClefModel : undefined;
}

function lunaReady(available: DecisionAvailability): boolean {
  return available.luna === true;
}

function explicitProvider(model?: string): DecisionProvider | undefined {
  if (!model) return undefined;
  if (clefModel(model)) return 'clef';
  return model === LUNA_DECISION_MODEL ? 'luna' : 'jev';
}

function route(provider: DecisionProvider, model: string, evidence: DecisionRoute['evidence'], reason: string): DecisionRoute {
  return { provider, model, evidence, reason, policyVersion: 'jev-clef-luna-v1' };
}

export type BrowserVisualBlocker = 'vision_disabled' | 'vision_consent_missing' | 'vision_provider_not_ready';

/**
 * Why the browser capture cannot leave the machine, or null when it can.
 * Juntos needs both recipients; every other mode (Somente Jev included) needs one
 * consented recipient of its image route with a ready credential.
 */
export function browserVisualBlocker(settings: DecisionSettings, available: DecisionAvailability): BrowserVisualBlocker | null {
  if (!settings.visionEnabled) return 'vision_disabled';
  const consented = visionRecipientsForMode(settings.mode).filter(recipient => hasVisionRecipientConsent(settings, recipient));
  const ready = consented.filter(recipient => recipient === 'clef' ? available.clef : lunaReady(available));
  const needed = settings.mode === 'together' ? 2 : 1;
  return consented.length < needed ? 'vision_consent_missing' : ready.length < needed ? 'vision_provider_not_ready' : null;
}

/** Vision can leave the machine only for browserTool, and only to a provider that accepts images. */
export function canRouteBrowserVisual(settings: DecisionSettings, available: DecisionAvailability): boolean {
  return browserVisualBlocker(settings, available) === null;
}

/**
 * Juntos, só com a escolha do operador. Quem não tem chave fica de fora.
 * Menos de dois membros devolve null: um sozinho não é conjunto.
 * Texto comum: Jev e Luna, a mesma pergunta. Sem o Jev, Luna e Clef formam
 * o conjunto; o Clef não entra nesse texto quando o par Jev+Luna já existe.
 * Segurança: quem tiver chave, no mínimo dois — Luna+Clef sem Jev é válido.
 * Rótulos de desktop e navegador não são conjunto (o Jev responde sozinho).
 * Imagem mascarada:
 * Clef e Luna; o Jev não vê imagem. Pixels de desktop não têm saída mascarada.
 * O modelo pedido pelo chamador não entra.
 */
export function ensembleMembers(input: RouteInput, settings: DecisionSettings, available: DecisionAvailability): DecisionRoute[] | null {
  if (settings.mode !== 'together') return null;
  const jev = route('jev', jevModel(settings), 'manual', 'ensemble');
  const luna = route('luna', LUNA_DECISION_MODEL, input.images?.length ? 'capability' : 'manual', 'ensemble');
  const clef = route('clef', settings.clefModel, input.images?.length ? 'capability' : 'manual', 'ensemble');
  if (input.images?.length) {
    if (!hasVisionRecipientConsent(settings, 'luna') || !hasVisionRecipientConsent(settings, 'clef') || !lunaReady(available) || !available.clef) return null;
    if (input.surface === 'computerTool') return null;
    if (input.surface && input.surface !== 'browserTool' && JEV_PINNED_SURFACES.has(input.surface)) return null;
    return [luna, clef];
  }
  if (input.surface && LABEL_SURFACES.has(input.surface)) return null;
  const security = Boolean(input.surface && SECURITY_ENSEMBLE_SURFACES.has(input.surface));
  const members: DecisionRoute[] = [];
  if (available.jev) members.push(jev);
  if (lunaReady(available)) members.push(luna);
  // Segurança: o Clef entra sempre que há chave. Texto comum: só completa a
  // Luna quando o Jev está de fora. Falta de Jev não zera o conjunto.
  if (available.clef && (security || (!available.jev && lunaReady(available)))) members.push(clef);
  return members.length >= 2 ? members : null;
}

function operatorLuna(input: RouteInput, available: DecisionAvailability, evidence: DecisionRoute['evidence']): DecisionRoute | null {
  if (!lunaReady(available)) return null;
  const pinned = Boolean(input.surface && JEV_PINNED_SURFACES.has(input.surface));
  return route('luna', LUNA_DECISION_MODEL, evidence, pinned ? 'operator-override' : 'manual');
}

/** The policy is deterministic; public benchmark evidence is not a local evaluation. */
export function resolveDecisionRoute(input: RouteInput, settings: DecisionSettings, available: DecisionAvailability): DecisionRoute | null {
  const explicitClef = clefModel(input.model);
  const pinned = explicitProvider(input.model);
  const selectedJevModel = input.model ?? jevModel(settings);
  if (settings.mode === 'together') {
    if (!input.images?.length && input.surface && LABEL_SURFACES.has(input.surface)) {
      if (!available.jev) return null;
      return route('jev', jevModel(settings), 'manual', 'labels');
    }
    return ensembleMembers(input, settings, available)?.[0] ?? null;
  }
  if (settings.mode === 'luna') {
    if (input.images?.length) {
      if (input.surface && input.surface !== 'browserTool' && JEV_PINNED_SURFACES.has(input.surface)) return null;
      if (!hasVisionRecipientConsent(settings, 'luna')) return null;
      return lunaReady(available) ? route('luna', LUNA_DECISION_MODEL, 'capability', 'vision') : null;
    }
    return operatorLuna(input, available, 'manual');
  }
  if (settings.mode !== 'auto' && pinned && pinned !== settings.mode) return null;
  if (input.images?.length) {
    // Imagem não contorna a fixação no Jev: só o julgamento visual do navegador sai da máquina.
    if (input.surface && input.surface !== 'browserTool' && JEV_PINNED_SURFACES.has(input.surface)) return null;
    // Somente Jev decide o texto; só a imagem do navegador segue a rota visual do Automático (Clef, depois Luna).
    if (!settings.visionEnabled || pinned === 'jev' || (settings.mode === 'jev' && input.surface !== 'browserTool')) return null;
    if (pinned === 'luna') {
      if (!hasVisionRecipientConsent(settings, 'luna') || !lunaReady(available)) return null;
      return route('luna', LUNA_DECISION_MODEL, 'capability', settings.mode === 'auto' ? 'explicit-model' : 'vision');
    }
    if (settings.mode === 'clef') {
      if (!hasVisionRecipientConsent(settings, 'clef') || !available.clef || (explicitClef && explicitClef !== settings.clefModel)) return null;
      return route('clef', settings.clefModel, 'capability', 'vision');
    }
    if (hasVisionRecipientConsent(settings, 'clef') && available.clef) return route('clef', explicitClef ?? 'clef', 'capability', 'vision');
    // Clef explícito sem credencial não vira Luna. A imagem da Luna fica no
    // Automático sem esse pedido, em Somente Luna e em Juntos.
    if (explicitClef) return null;
    if (hasVisionRecipientConsent(settings, 'luna') && lunaReady(available)) return route('luna', LUNA_DECISION_MODEL, 'capability', 'credential-fallback');
    return null;
  }
  if (input.surface && JEV_PINNED_SURFACES.has(input.surface)) {
    if (explicitClef || pinned === 'luna' || settings.mode === 'clef' || !available.jev) return null;
    return settings.mode === 'jev'
      ? route('jev', selectedJevModel, 'manual', 'manual')
      : route('jev', selectedJevModel, 'legacy', 'jev-pinned');
  }
  if (settings.mode === 'jev') return available.jev ? route('jev', selectedJevModel, 'manual', 'manual') : null;
  if (settings.mode === 'clef') {
    if (!available.clef || (explicitClef && explicitClef !== settings.clefModel)) return null;
    return route('clef', settings.clefModel, 'manual', 'manual');
  }
  if (pinned) {
    const ready = pinned === 'luna' ? lunaReady(available) : available[pinned];
    if (!ready) return null;
    const model = pinned === 'clef' ? explicitClef ?? 'clef' : pinned === 'luna' ? LUNA_DECISION_MODEL : selectedJevModel;
    return route(pinned, model, 'manual', 'explicit-model');
  }
  const preferred: DecisionProvider = input.surface && CLEF_PREFERRED_SURFACES.has(input.surface) ? 'clef' : 'jev';
  const order: DecisionProvider[] = preferred === 'clef' ? ['clef', 'jev', 'luna'] : ['jev', 'clef', 'luna'];
  const selected = order.find(provider => provider === 'luna' ? lunaReady(available) : available[provider]);
  if (!selected) return null;
  const evidence = selected === 'clef' && preferred === 'clef' ? 'public-benchmark' : 'legacy';
  const autoReason = input.surface === 'toolPick' ? 'tool-selection'
    : input.surface === 'researchTriage' ? 'research-triage'
    : input.surface === 'rank' || input.surface === 'rankTool' ? 'ranking'
    : 'public-benchmark';
  return route(selected, selected === 'clef' ? 'clef' : selected === 'luna' ? LUNA_DECISION_MODEL : selectedJevModel, evidence,
    selected !== preferred ? 'credential-fallback' : selected === 'clef' ? autoReason : 'legacy');
}
