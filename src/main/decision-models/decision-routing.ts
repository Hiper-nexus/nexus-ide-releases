import { LUNA_DECISION_MODEL, type DecisionProvider, type DecisionRoute, type DecisionSettings, type ClefModel } from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';

export interface DecisionAvailability { jev: boolean; clef: boolean; luna?: boolean }
type RouteInput = Pick<JudgeInput, 'surface' | 'model' | 'images'>;

/**
 * Surfaces that gate or feed an effect (dispatch guard, handoff acceptance,
 * persistent memory, desktop and browser automation). Their thresholds were
 * calibrated against Jev. Neither the Clef public benchmarks nor the Luna
 * Decisions beta cover them, so they stay on Jev in every mode — including
 * explicit Luna. Without a Jev key they have no route (the guard becomes
 * `skipped`, fail-open as before). They must not go to Luna.
 */
export const JEV_PINNED_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool',
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

export function clefModel(model?: string): ClefModel | undefined {
  const selector = model?.replace('@cf/cloudflare/', '');
  return selector === 'clef' || selector === 'clef-flash' ? selector : undefined;
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

/** Vision can leave the machine only for browserTool, and only to a provider that accepts images. */
export function canRouteBrowserVisual(settings: DecisionSettings, available: DecisionAvailability): boolean {
  if (!settings.visionEnabled || settings.mode === 'jev') return false;
  if (settings.mode === 'luna') return lunaReady(available);
  if (settings.mode === 'clef') return available.clef;
  return available.clef || lunaReady(available);
}

/** The policy is deterministic; public benchmark evidence is not a local evaluation. */
export function resolveDecisionRoute(input: RouteInput, settings: DecisionSettings, available: DecisionAvailability): DecisionRoute | null {
  const explicitClef = clefModel(input.model);
  const pinned = explicitProvider(input.model);
  const jevModel = input.model ?? process.env.NEXUS_JEV_MODEL ?? 'jev-latest';
  if (settings.mode !== 'auto' && pinned && pinned !== settings.mode) return null;
  if (input.images?.length) {
    // Imagem não contorna a fixação no Jev: só o julgamento visual do navegador sai da máquina.
    if (input.surface && input.surface !== 'browserTool' && JEV_PINNED_SURFACES.has(input.surface)) return null;
    if (!settings.visionEnabled || settings.mode === 'jev' || pinned === 'jev') return null;
    if (settings.mode === 'luna' || pinned === 'luna') {
      if (!lunaReady(available)) return null;
      return route('luna', LUNA_DECISION_MODEL, 'capability', pinned === 'luna' && settings.mode === 'auto' ? 'explicit-model' : 'vision');
    }
    if (settings.mode === 'clef') {
      if (!available.clef || (explicitClef && explicitClef !== settings.clefModel)) return null;
      return route('clef', settings.clefModel, 'capability', 'vision');
    }
    if (available.clef) return route('clef', explicitClef ?? 'clef', 'capability', 'vision');
    if (lunaReady(available)) return route('luna', LUNA_DECISION_MODEL, 'capability', 'credential-fallback');
    return null;
  }
  if (input.surface && JEV_PINNED_SURFACES.has(input.surface)) {
    if (explicitClef || pinned === 'luna' || settings.mode === 'clef' || !available.jev) return null;
    return settings.mode === 'jev'
      ? route('jev', jevModel, 'manual', 'manual')
      : route('jev', jevModel, 'legacy', 'jev-pinned');
  }
  if (settings.mode === 'jev') return available.jev ? route('jev', jevModel, 'manual', 'manual') : null;
  if (settings.mode === 'clef') {
    if (!available.clef || (explicitClef && explicitClef !== settings.clefModel)) return null;
    return route('clef', settings.clefModel, 'manual', 'manual');
  }
  if (settings.mode === 'luna') return lunaReady(available) ? route('luna', LUNA_DECISION_MODEL, 'manual', 'manual') : null;
  if (pinned) {
    const ready = pinned === 'luna' ? lunaReady(available) : available[pinned];
    if (!ready) return null;
    const model = pinned === 'clef' ? explicitClef ?? 'clef' : pinned === 'luna' ? LUNA_DECISION_MODEL : jevModel;
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
  return route(selected, selected === 'clef' ? 'clef' : selected === 'luna' ? LUNA_DECISION_MODEL : jevModel, evidence,
    selected !== preferred ? 'credential-fallback' : selected === 'clef' ? autoReason : 'legacy');
}
