/**
 * Decisão de engate do transporte realtime, PURA e testável. A borda
 * (LiveTransportController) resolve a fonte de cada key (secrets store / env)
 * pela MESMA cadeia do resto da voz (resolveVoiceApiKey) e passa aqui só a
 * PRESENÇA — nunca o valor. Isto vira uma linha única em voice.log: qual
 * transporte foi pedido, qual provider engatou e, quando degradou p/ Classic,
 * POR QUÊ. Era a maior lacuna de observabilidade do stack (o log não dizia
 * nada sobre o motivo da degradação).
 */

import type { JarvisLiveTransport } from '../../../shared/voice-config';
import type { RealtimeProviderId } from './provider';
import type { VoiceApiKeySource } from '../../voice/voice-secrets';

export interface EngageCandidate {
  id: RealtimeProviderId;
  envVar: string;
  source: VoiceApiKeySource;
}

export interface EngageDecisionInput {
  transport: JarvisLiveTransport;
  /** Ordem de tentativa (gemini→openai→…), com a fonte de cada key. */
  candidates: EngageCandidate[];
}

export interface EngageDecision {
  engaged: RealtimeProviderId | null;
  degraded: boolean;
  reason: string;
  /** Linha única para voice.log; também serve de chave de dedupe. */
  line: string;
}

function hasKey(source: VoiceApiKeySource): boolean {
  return source === 'stored' || source === 'env';
}

export function buildRealtimeEngageDecision(
  input: EngageDecisionInput,
): EngageDecision {
  const keysPart = input.candidates
    .map((c) => `${c.envVar}=${c.source}`)
    .join(' ');
  const engagedCandidate = input.candidates.find((c) => hasKey(c.source)) ?? null;

  let reason: string;
  if (input.transport === 'classic') {
    reason = 'transport configured as Classic';
  } else if (!engagedCandidate) {
    const wanted = input.candidates.map((c) => c.id).join('→') || 'none';
    reason = `no realtime key present for ${wanted}; degraded to Classic`;
  } else if (engagedCandidate.id === input.candidates[0]?.id) {
    reason = `engaged ${engagedCandidate.id} (key from ${engagedCandidate.source})`;
  } else {
    reason = `preferred provider had no key; engaged fallback ${engagedCandidate.id} (key from ${engagedCandidate.source})`;
  }

  const engagedLabel = engagedCandidate?.id ?? 'classic';
  const line = `transport=${input.transport} engaged=${engagedLabel}${
    keysPart ? ` ${keysPart}` : ''
  } — ${reason}`;

  return {
    engaged: engagedCandidate?.id ?? null,
    degraded: engagedCandidate === null,
    reason,
    line,
  };
}
