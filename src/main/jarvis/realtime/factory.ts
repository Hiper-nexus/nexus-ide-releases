import fs from 'node:fs';
import bundledSystemPrompt from '../prompts/system.en.md?raw';
import { resolveVoiceApiKey } from '../../voice/voice-secrets';
import { buildToolset } from '../../orch/tools';
import type { VoiceConfig } from '../../../shared/voice-config';
import { GeminiLiveProvider } from './gemini-live-provider';
import { createNexusRealtimeTools } from './nexus-realtime-tools';
import { createGeminiRealtimeTools } from './gemini-realtime-tools';
import { OpenAIRealtimeProvider } from './openai-realtime';
import type {
  RealtimeProviderId,
  TurnManagedRealtimeProvider,
} from './provider';

export interface RealtimeProviderFactoryOptions {
  config: VoiceConfig;
  instructions?: string;
  promptPath?: string;
  geminiResumeHandle?: string;
  onGeminiResumeHandle?(handle: string | undefined): void;
}

export interface RealtimeProviderCandidate {
  id: RealtimeProviderId;
  provider: TurnManagedRealtimeProvider;
}

const OPENAI_REALTIME_FALLBACK_VOICE = 'marin';
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

export function resolveOpenAiRealtimeVoice(configured: string): string {
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
- For open-ended conversation, answer directly with realtime audio and do not call a tool.
- Nexus context is structured metadata, not pixels, DOM, or browser-page body.
  Answer only facts explicitly present there (for example title, URL, workspace,
  missions, or local time). For pane output call a read-only tool. If no tool
  returns the requested content, say you cannot inspect it; never invent it.
- When the user asks you to operate Nexus IDE, call a coarse voice tool (\`navegar\`, \`delegar\`, \`consultar\`, \`ler\`, \`comandar\`, \`restaurar\`, \`perguntar\`) or \`nexus_action\`.
- Squad flow (Overclock parity): "iniciar/montar squad" → \`navegar\` target \`design-squad\` (opens review). After the tool result, ASK if they want to start. On "sim/inicia/confirma" → \`navegar\` target \`wizard-fire\`.
- \`nexus_action\` can open UI areas, focus/switch panes, delegate work to panes, request terminal commands, and invoke Nexus MCP tools through \`mcp_tool\`.
- Use \`mcp_tool\` only for Nexus tools named \`nexus_*\` (files, git, editor, panes, missions, browser, catalog, media).
- Use \`run_command\` only when the user explicitly asks for a shell command. Pass the exact command, with no extra shell tricks.
- Sensitive actions and commands are confirmed by the app through native guardrails; do not bypass or simulate confirmation.
- Do not claim an action was performed until a tool/action result is provided.
- Keep the conversation continuous: after acting, stay listening — do not require another wake word for the next turn.

Available realtime tools: coarse voice tools (delegar/consultar/ler/navegar/encerrar/comandar/restaurar/perguntar) and \`nexus_action\` for audited Nexus IDE operations. Speak directly for normal conversation.`;

const GEMINI_COARSE_TOOLS_ADDENDUM = `Gemini Live tools:
- When the user asks you to operate Nexus IDE, use one of the declared coarse voice tools: \`navegar\`, \`delegar\`, \`consultar\`, \`ler\`, \`encerrar\`, \`comandar\`, \`restaurar\`, or \`perguntar\`.
- \`nexus_action\` is also declared for audited Nexus operations. Its \`run_command\` and \`mcp_tool\` actions keep the native confirmation and MCP guardrails; never bypass them.
- Squad flow: "iniciar/montar squad" → \`navegar\` target \`design-squad\`. After the tool result, ask if they want to start. On "sim/inicia/confirma" → \`navegar\` target \`wizard-fire\`.`;

export function geminiInstructions(base: string): string {
  return `${base.trim()}\n\n${GEMINI_COARSE_TOOLS_ADDENDUM}`;
}

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
  // gemini-live prefers Gemini but falls back to OpenAI Realtime: if the
  // configured Gemini key is absent while OPENAI_API_KEY resolves, realtime
  // still engages (createRealtimeProviderCandidates only builds a candidate for
  // a provider whose key resolves, so a keyless Gemini is skipped and OpenAI
  // wins). Order encodes the gemini→openai→classic degrade path.
  if (config.jarvisLive.transport === 'gemini-live') return ['gemini', 'openai'];
  return [];
}

export function loadJarvisSystemPrompt(promptPath?: string): string {
  if (promptPath) {
    try {
      return fs.readFileSync(promptPath, 'utf-8').trim();
    } catch {
      return FALLBACK_SYSTEM_PROMPT;
    }
  }
  const bundled = bundledSystemPrompt.trim();
  return bundled.length > 0 ? bundled : FALLBACK_SYSTEM_PROMPT;
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
              tools: createNexusRealtimeTools(),
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
          instructions: geminiInstructions(instructions),
          // Gemini sees the exact Nexus MCP schemas. Execution still goes
          // through nexus_action/mcp_tool so confirmation, cancellation,
          // exactly-once delivery and result redaction keep a single owner.
          tools: createGeminiRealtimeTools(buildToolset(), createNexusRealtimeTools()),
          resumeHandle: options.geminiResumeHandle,
          onResumptionHandle: options.onGeminiResumeHandle,
        }),
      });
    }
  }
  return candidates;
}
