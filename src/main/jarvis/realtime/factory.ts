import fs from 'node:fs';
import bundledSystemPrompt from '../prompts/system.en.md?raw';
import { resolveVoiceApiKey } from '../../voice/voice-secrets';
import type { VoiceConfig } from '../../../shared/voice-config';
import { REALTIME_FALLBACK_CHAIN } from '../../../shared/voice-config';
import { coarseVoiceToolsAsRealtimeDefinitions } from './coarse-voice-tools';
import { GeminiLiveProvider } from './gemini-live-provider';
import { createGrokRealtimeProvider } from './grok-realtime';
import { createNexusRealtimeTools } from './nexus-realtime-tools';
import { createGeminiRealtimeTools } from './gemini-realtime-tools';
import { OpenAIRealtimeProvider } from './openai-realtime';
import type {
  RealtimeProviderId,
  TurnManagedRealtimeProvider,
} from './provider';
import { withNexusVoicePolicy } from '../../voice/jarvis-voice-policy';

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

const OPENAI_REALTIME_FALLBACK_VOICE = 'ash';
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
- For a visible Nexus screen/page, use \`read_current_view\`. Its result may contain
  fresh opaque \`actions\` refs. Act only after an explicit user request by calling
  \`mcp_tool\` \`nexus_ui_action\` with that exact ref; it keeps native confirmation.
  Never invent a ref, CSS selector, or JavaScript.
- When the user asks you to operate Nexus IDE, call a coarse voice tool (\`navegar\`, \`delegar\`, \`consultar\`, \`ler\`, \`comandar\`, \`restaurar\`, \`perguntar\`) or \`nexus_action\`.
- Squad flow: opening/starting squad mode without a squad name → ask which saved squad, using only names from current context, and do not call a tool yet. A named saved squad → \`navegar\` target \`squad\` with its name. Only an explicit create/design/new-squad request → \`navegar\` target \`design-squad\` (opens review). After the tool result, ASK if they want to use that squad. On "sim/usar/continuar" → \`navegar\` target \`wizard-fire\`; this advances the wizard and does not replace the native approval before execution.
- Workspace flow: "abrir/entrar no projeto X" means existing workspace → \`open_workspace\` or \`navegar\` target \`workspace\` with query X. Use \`new_workspace\` only when the user explicitly says novo/criar. Never turn a failed lookup into creation.
- Pane targeting: use the canonical pane id present in structured context when available. Never guess an id or reroute to a different pane.
- \`nexus_action\` can open UI areas, focus/switch panes, delegate work to panes, request terminal commands, and invoke Nexus MCP tools through \`mcp_tool\`.
- “sincroniza/atualiza/puxa o repositório local com GitHub/origin” → \`nexus_action\` action \`sync_repository\`. It is a bounded direct fast-forward operation; never delegate it or open a mission, squad, terminal, pane, or Doctor.
- Use \`mcp_tool\` only for Nexus tools named \`nexus_*\` (files, git, editor, panes, missions, browser, catalog, media).
- Use \`run_command\` only when the user explicitly asks for a syntactically real shell command. Pass the exact command, with no extra shell tricks. Never put prose, an Objective, execution requirements, acceptance criteria, or an agent briefing in \`command\`; use \`send_to_pane\` for that.
- Routine local commands run hands-free. Destructive, deploy, publish, remote, and other sensitive actions are confirmed by the app through native guardrails; do not bypass or simulate confirmation.
- Do not claim an action was performed until a tool/action result is provided.
- An explicit request to fix, investigate, implement, refactor, adjust, or apply
  engineering work MUST call \`delegar\` immediately. Reading a pane is only a
  diagnostic step and never completes that request. Never say “I will analyze”
  or promise future work without delegating it in the same turn.
- Before delegation, transform the spoken request into an execution-ready English
  engineering brief with Objective, Execution requirements, and Acceptance criteria.
  Preserve explicit user constraints and relevant current Nexus context. Infer only
  necessary implementation/testing details; never invent scope, stack, provider,
  account, target pane, or destructive operations. Ask one short clarification when
  a missing choice would materially change the result.
- Never invent Nexus MCP tool names. If a tool fails or is unavailable, recover
  with a declared coarse tool; engineering work uses \`delegar\`.
- Keep the conversation continuous: after acting, stay listening — do not require another wake word for the next turn.

Available realtime tools: coarse voice tools (delegar/consultar/ler/navegar/encerrar/comandar/restaurar/perguntar) and \`nexus_action\` for audited Nexus IDE operations. Speak directly for normal conversation.`;

const GEMINI_COARSE_TOOLS_ADDENDUM = `Gemini Live tools:
- When the user asks you to operate Nexus IDE, use one of the declared coarse voice tools: \`navegar\`, \`delegar\`, \`consultar\`, \`ler\`, \`encerrar\`, \`comandar\`, \`restaurar\`, or \`perguntar\`.
- Fix/investigate/implement/refactor requests are real work: call \`delegar\` in
  that same turn. \`ler\` alone is not completion and a spoken promise is not an action.
- Before calling \`delegar\`, transform the spoken request into an execution-ready
  English engineering brief with Objective, Execution requirements, and Acceptance criteria.
  Preserve explicit user constraints and relevant current Nexus context. Infer only
  necessary implementation/testing details; never invent scope, stack, provider,
  account, target pane, or destructive operations. Ask one short clarification when
  a missing choice would materially change the result.
- \`nexus_action\` is also declared for audited Nexus operations. Its \`run_command\` and \`mcp_tool\` actions keep the native confirmation and MCP guardrails; never bypass them.
- Repository sync is the sole direct Git operation: “sincroniza/atualiza/puxa o repositório local com GitHub/origin” → \`nexus_action\` action \`sync_repository\`, never \`delegar\`. It validates the checkout and only fast-forwards safely.
- Visible view read: “leia esta tela/página” or “o que tem aqui” → \`ler\` with scope \`view\`. This uses local accessibility + OCR context; do not use a pane read or invent what is visible.
- After that read, only an explicit request to activate a returned control may use \`mcp_tool\` \`nexus_ui_action\` with its fresh opaque ref. Native confirmation remains mandatory; never invent refs or selectors.
- Mission modes: “iniciar/criar missão no modo agêntico” → \`navegar\` target \`mission-agentic\`, with \`query\` only for an objective the user already stated. This opens the Agentic objective step; never use \`open_voice_settings\`, \`design-squad\`, or \`wizard-fire\` for this request.
- Existing workspace: “abre/entra no projeto X” → \`navegar\` target \`workspace\`, query X. New workspace is only for an explicit “novo/criar workspace”; a lookup miss must never open the creation wizard.
- Panes in structured context include stable ids. Use those ids for an explicit target; never invent or silently substitute another pane.
- Squad flow: opening/starting squad mode without a squad name → ask which saved squad from current context and do not call a tool yet. A named saved squad → \`navegar\` target \`squad\` with its name. Only an explicit create/design/new-squad request → \`navegar\` target \`design-squad\`. After the tool result, ask if they want to use that squad. On "sim/usar/continuar" → \`navegar\` target \`wizard-fire\`; this advances the wizard and does not replace the native approval before execution.`;

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
  if (forced === 'grok' || forced === 'openai' || forced === 'gemini') {
    return [forced];
  }
  // A ordem de degradação vive em REALTIME_FALLBACK_CHAIN (shared) porque o
  // diagnóstico da UI precisa da MESMA cadeia para não mandar o operador
  // conferir a credencial errada. Grok Voice é a rota oficial; openai e gemini
  // seguem como degradação automática quando a XAI_API_KEY não resolve
  // (createRealtimeProviderCandidates só constrói candidato de provider com
  // chave, então uma rota sem chave é pulada em silêncio em vez de derrubar o
  // realtime). `classic` não tem cadeia: sai vazio e o Classic assume.
  const transport = config.jarvisLive.transport;
  if (transport === 'classic') return [];
  return [...REALTIME_FALLBACK_CHAIN[transport]];
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
  const baseInstructions =
    options.instructions ?? loadJarvisSystemPrompt(options.promptPath);
  const candidates: RealtimeProviderCandidate[] = [];
  for (const providerId of resolveRealtimeProviderIds(options.config)) {
    if (providerId === 'grok') {
      const apiKey = resolveVoiceApiKey('XAI_API_KEY');
      if (apiKey) {
        candidates.push({
          id: providerId,
          provider: createGrokRealtimeProvider({
            apiKey,
            model: live.grokModel,
            voice: live.grokVoice,
            instructions: withNexusVoicePolicy(baseInstructions),
            tools: [
              ...coarseVoiceToolsAsRealtimeDefinitions(),
              ...createNexusRealtimeTools(),
            ],
          }),
        });
      }
      continue;
    }

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
              instructions: withNexusVoicePolicy(baseInstructions),
              tools: [
                ...coarseVoiceToolsAsRealtimeDefinitions(),
                ...createNexusRealtimeTools(),
              ],
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
          instructions: withNexusVoicePolicy(
            geminiInstructions(baseInstructions),
          ),
          // A bounded spoken-action surface prevents overlapping MCP schemas
          // from turning an imperative into a similarly named wrong action.
          // Detailed operations remain available through audited nexus_action.
          tools: createGeminiRealtimeTools(createNexusRealtimeTools()),
          resumeHandle: options.geminiResumeHandle,
          onResumptionHandle: options.onGeminiResumeHandle,
        }),
      });
    }
  }
  return candidates;
}
