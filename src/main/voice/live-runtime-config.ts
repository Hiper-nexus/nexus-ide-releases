import type { VoiceConfig } from '../../shared/voice-config';

export function liveRuntimeFingerprint(config: VoiceConfig): string {
  const live = config.jarvisLive;
  return JSON.stringify({
    enabled: live.enabled,
    transport: live.transport,
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

export function isLiveTransportCredential(envVar: string): boolean {
  return envVar === 'GEMINI_API_KEY' || envVar === 'OPENAI_API_KEY';
}
