import type { DecisionProvider, DecisionRoute, DecisionSettings, ClefModel } from '../../shared/decision-models';
import type { JudgeInput } from '../jev/jev-client';

export interface DecisionAvailability { jev: boolean; clef: boolean }
type RouteInput = Pick<JudgeInput, 'surface' | 'model' | 'images'>;

function clefModel(model?: string): ClefModel | undefined {
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
