import fs from 'node:fs';
import path from 'node:path';
import { resolveVoiceApiKey } from '../../voice/voice-secrets';
import type { VoiceConfig } from '../../../shared/voice-config';
import { GeminiLiveProvider } from './gemini-live-provider';
import { OpenAIRealtimeProvider } from './openai-realtime';
import type {
  RealtimeProviderId,
  TurnManagedRealtimeProvider,
} from './provider';

export interface RealtimeProviderFactoryOptions {
  config: VoiceConfig;
  instructions?: string;
  promptPath?: string;
}

export interface RealtimeProviderCandidate {
  id: RealtimeProviderId;
  provider: TurnManagedRealtimeProvider;
}

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'system.en.md');
const OPENAI_REALTIME_FALLBACK_VOICE = 'alloy';
const OPENAI_REALTIME_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);

function resolveOpenAiRealtimeVoice(configured: string): string {
  const voice = configured.trim().toLowerCase();
  return OPENAI_REALTIME_VOICES.has(voice) ? voice : OPENAI_REALTIME_FALLBACK_VOICE;
}
const FALLBACK_SYSTEM_PROMPT = `You are Jarvis, the voice assistant embedded in Nexus IDE.
You have full authority over actions inside the Nexus IDE (files, terminal, git, editor, panes).
For actions outside Nexus, refuse and explain you're scoped to the IDE only in this version.

Response rules:
- Answer in the user's language (they will speak Portuguese most of the time).
- Keep spoken responses concise (1-3 sentences max unless asked for detail).
- When executing an action, briefly narrate what you're doing.
- Destructive actions (rm, git push --force, git reset --hard, sudo) MUST ask explicit confirmation before running.
- In Phase 3 realtime sessions do not receive action tools. Nexus actions are executed by the classic batch Jarvis path; do not claim an action was performed unless a tool/action result is provided.

Available realtime tools: none in Phase 3. Populated dynamically in Phase 4.`;

export function resolveRealtimeProviderId(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): RealtimeProviderId | null {
  return resolveRealtimeProviderIds(config, env)[0] ?? null;
}

export function resolveRealtimeProviderIds(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): RealtimeProviderId[] {
  const forced = env.NEXUS_REALTIME_PROVIDER?.trim().toLowerCase();
  if (forced === 'openai' || forced === 'gemini') return [forced];
  if (config.jarvisLive.transport === 'openai-realtime') return ['openai', 'gemini'];
  if (config.jarvisLive.transport === 'gemini-live') return ['gemini'];
  return [];
}

export function loadJarvisSystemPrompt(promptPath = SYSTEM_PROMPT_PATH): string {
  try {
    return fs.readFileSync(promptPath, 'utf-8').trim();
  } catch {
    return FALLBACK_SYSTEM_PROMPT;
  }
}

export function createRealtimeProvider(
  options: RealtimeProviderFactoryOptions,
): TurnManagedRealtimeProvider | null {
  return createRealtimeProviderCandidates(options)[0]?.provider ?? null;
}

export function createRealtimeProviderCandidates(
  options: RealtimeProviderFactoryOptions,
): RealtimeProviderCandidate[] {
  const live = options.config.jarvisLive;
  const instructions = options.instructions ?? loadJarvisSystemPrompt(options.promptPath);
  const candidates: RealtimeProviderCandidate[] = [];
  for (const providerId of resolveRealtimeProviderIds(options.config)) {
    if (providerId === 'openai') {
      const apiKey = resolveVoiceApiKey('OPENAI_API_KEY');
      if (apiKey) {
        const configuredVoice = resolveOpenAiRealtimeVoice(live.openaiVoice);
        const voices =
          configuredVoice === OPENAI_REALTIME_FALLBACK_VOICE
            ? [configuredVoice]
            : [configuredVoice, OPENAI_REALTIME_FALLBACK_VOICE];
        for (const voice of voices) {
          candidates.push({
            id: providerId,
            provider: new OpenAIRealtimeProvider({
              apiKey,
              model: live.openaiModel,
              voice,
              instructions,
            }),
          });
        }
      }
      continue;
    }

    const apiKey = resolveVoiceApiKey('GEMINI_API_KEY');
    if (apiKey) {
      candidates.push({
        id: providerId,
        provider: new GeminiLiveProvider({
          apiKey,
          model: live.liveModel,
          voiceName: live.voiceName,
          instructions,
        }),
      });
    }
  }
  return candidates;
}
