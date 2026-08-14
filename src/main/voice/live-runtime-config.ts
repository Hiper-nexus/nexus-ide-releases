import {
  REALTIME_PROVIDER_ENV_VAR,
  type VoiceConfig,
} from '../../shared/voice-config';

export function liveRuntimeFingerprint(config: VoiceConfig): string {
  const live = config.jarvisLive;
  return JSON.stringify({
    enabled: live.enabled,
    transport: live.transport,
    grokModel: live.grokModel,
    grokVoice: live.grokVoice,
    openaiModel: live.openaiModel,
    openaiVoice: live.openaiVoice,
    liveModel: live.liveModel,
    voiceName: live.voiceName,
    persona: {
      assistantName: config.persona.assistantName,
      userName: config.persona.userName ?? '',
      customInstructions: config.persona.customInstructions ?? '',
    },
  });
}

const LIVE_TRANSPORT_ENV_VARS = new Set(
  Object.values(REALTIME_PROVIDER_ENV_VAR),
);

export function isLiveTransportCredential(envVar: string): boolean {
  return LIVE_TRANSPORT_ENV_VARS.has(envVar);
}
