import type { DecisionProvider, DecisionRoute, DecisionSettings, ClefModel } from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';

export interface DecisionAvailability { jev: boolean; clef: boolean }
type RouteInput = Pick<JudgeInput, 'surface' | 'model' | 'images'>;

/**
 * Surfaces that gate or feed an effect (dispatch guard, handoff acceptance,
 * persistent memory, desktop and browser automation). Their thresholds were
 * calibrated against Jev; the Clef public benchmarks do not cover them, so they
 * never go to Clef until a local evaluation of their own says otherwise. Without
 * a Jev key they have no route (the guard becomes `skipped`, fail-open as before).
 */
export const JEV_PINNED_SURFACES: ReadonlySet<JevDecisionSurface> = new Set<JevDecisionSurface>([
  'dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool',
]);

export function clefModel(model?: string): ClefModel | undefined {
  const selector = model?.replace('@cf/cloudflare/', '');
  return selector === 'clef' || selector === 'clef-flash' ? selector : undefined;
}

function route(provider: DecisionProvider, model: string, evidence: DecisionRoute['evidence'], reason: string): DecisionRoute {
  return { provider, model, evidence, reason, policyVersion: 'jev-clef-v1' };
}

/** The policy is deterministic; public benchmark evidence is not a local evaluation. */
export function resolveDecisionRoute(input: RouteInput, settings: DecisionSettings, available: DecisionAvailability): DecisionRoute | null {
  const explicitClef = clefModel(input.model);
  const explicitProvider = input.model ? explicitClef ? 'clef' : 'jev' : undefined;
  const jevModel = input.model ?? process.env.NEXUS_JEV_MODEL ?? 'jev-latest';
  if (settings.mode !== 'auto' && explicitProvider && explicitProvider !== settings.mode) return null;
  if (input.images?.length) {
    if (!settings.visionEnabled || settings.mode === 'jev' || explicitProvider === 'jev' || !available.clef) return null;
    const selected = settings.mode === 'clef' ? settings.clefModel : explicitClef ?? 'clef';
    if (explicitClef && settings.mode === 'clef' && explicitClef !== selected) return null;
    return route('clef', selected, 'capability', 'vision');
  }
  if (input.surface && JEV_PINNED_SURFACES.has(input.surface)) {
    if (explicitClef || settings.mode === 'clef' || !available.jev) return null;
    return settings.mode === 'jev' ? route('jev', jevModel, 'manual', 'manual') : route('jev', jevModel, 'legacy', 'jev-pinned');
  }
  if (settings.mode === 'jev') return available.jev ? route('jev', jevModel, 'manual', 'manual') : null;
  if (settings.mode === 'clef') {
    if (!available.clef || (explicitClef && explicitClef !== settings.clefModel)) return null;
    return route('clef', settings.clefModel, 'manual', 'manual');
  }
  if (explicitProvider) {
    if (!available[explicitProvider]) return null;
    return route(explicitProvider, explicitClef ?? jevModel, 'manual', 'explicit-model');
  }
  const preferred = input.surface === 'toolPick' ? 'clef' : 'jev';
  const selected = available[preferred] ? preferred : preferred === 'jev' ? 'clef' : 'jev';
  if (!available[selected]) return null;
  const evidence = selected === 'clef' && preferred === 'clef' ? 'public-benchmark' : 'legacy';
  return route(selected, selected === 'clef' ? 'clef' : jevModel, evidence,
    selected !== preferred ? 'credential-fallback' : selected === 'clef' ? 'tool-selection' : 'legacy');
}
