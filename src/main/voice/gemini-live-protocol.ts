import {
  COARSE_VOICE_TOOLS,
  type GeminiFunctionDeclaration,
} from '../jarvis/realtime/coarse-voice-tools';

const PT_BR_SYSTEM_INSTRUCTION =
  'Idioma de voz padrão: português brasileiro (pt-BR). Mude apenas se o usuário pedir outro idioma.';
const GEMINI_31_MODEL_PREFIX = 'gemini-3.1-';
// F-090 (paridade Overclock): modelos half-cascade (gemini-3.1-*-live) usam
// `languageCode` no speechConfig para PINAR o pt-BR do TTS — sem ele o sotaque
// e a prosódia variam e o STT confunde comandos, o que derruba o turno pro
// fallback Classic. Modelos native-audio (2.5) IGNORAM o campo e auto-detectam,
// então lá ele fica de fora (a instrução de idioma no prompt segura o sotaque).
const LIVE_SPEECH_LANGUAGE_CODE = 'pt-BR';
export const CONTEXT_UPDATE_ENVELOPE = '[context_update]';
const GEMINI_31_CONTEXT_INSTRUCTION =
  'Mensagens iniciadas por [context_update] são telemetria interna do Nexus: atualize seu contexto silenciosamente e nunca responda ou fale por causa delas.';

export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface SetupMessage {
  setup: {
    model: string;
    generationConfig: Record<string, unknown>;
    systemInstruction: { parts: Array<{ text: string }> };
    tools: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
    inputAudioTranscription: Record<string, never>;
    outputAudioTranscription: Record<string, never>;
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false;
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH';
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH';
        prefixPaddingMs: number;
        silenceDurationMs: number;
      };
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS';
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY';
    };
    contextWindowCompression: { slidingWindow: Record<string, never> };
    sessionResumption: Record<string, unknown>;
  };
}

export interface ParsedServerMessage {
  setupComplete?: boolean;
  audioB64s?: string[];
  inputTranscription?: string;
  outputTranscription?: string;
  interrupted?: boolean;
  turnComplete?: boolean;
  resumptionHandle?: string;
  goAway?: boolean;
  toolCalls?: LiveToolCall[];
  cancelledToolCallIds?: string[];
}

export function usesGemini31Contract(model: string): boolean {
  return model.replace(/^models\//, '').startsWith(GEMINI_31_MODEL_PREFIX);
}

export function buildSetupMessage(opts: {
  model: string;
  voiceName: string;
  systemInstruction: string;
  resumeHandle?: string;
  tools?: GeminiFunctionDeclaration[];
}): SetupMessage {
  const baseInstruction = opts.systemInstruction.trim();
  const instructionParts = [baseInstruction];
  if (!baseInstruction.toLowerCase().includes('pt-br')) {
    instructionParts.push(PT_BR_SYSTEM_INSTRUCTION);
  }
  if (
    usesGemini31Contract(opts.model) &&
    !baseInstruction.includes(CONTEXT_UPDATE_ENVELOPE)
  ) {
    instructionParts.push(GEMINI_31_CONTEXT_INSTRUCTION);
  }
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['AUDIO'],
    temperature: 0.3,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } },
    },
  };
  if (usesGemini31Contract(opts.model)) {
    generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
    // Half-cascade: pina o idioma do TTS (Overclock F-090). Native-audio (2.5)
    // fica sem o campo para não conflitar com a auto-detecção do modelo.
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } },
      languageCode: LIVE_SPEECH_LANGUAGE_CODE,
    };
  }
  return {
    setup: {
      model: `models/${opts.model.replace(/^models\//, '')}`,
      generationConfig,
      systemInstruction: {
        parts: [{ text: instructionParts.filter(Boolean).join('\n\n') }],
      },
      tools: [{ functionDeclarations: opts.tools ?? COARSE_VOICE_TOOLS }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 20,
          silenceDurationMs: 300,
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
    },
  };
}

export function parseServerMessage(raw: string): ParsedServerMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: ParsedServerMessage = {};
  if (msg.setupComplete !== undefined) out.setupComplete = true;
  const content = msg.serverContent as
    | {
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      }
    | undefined;
  if (content) {
    const audioB64s = (content.modelTurn?.parts ?? [])
      .map((part) => part.inlineData?.data)
      .filter((data): data is string => typeof data === 'string' && data.length > 0);
    if (audioB64s.length > 0) out.audioB64s = audioB64s;
    if (typeof content.inputTranscription?.text === 'string') {
      out.inputTranscription = content.inputTranscription.text;
    }
    if (typeof content.outputTranscription?.text === 'string') {
      out.outputTranscription = content.outputTranscription.text;
    }
    if (content.interrupted) out.interrupted = true;
    if (content.turnComplete) out.turnComplete = true;
  }
  const toolCall = msg.toolCall as
    | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
    | undefined;
  if (Array.isArray(toolCall?.functionCalls)) {
    const calls: LiveToolCall[] = [];
    for (const fc of toolCall.functionCalls) {
      if (typeof fc?.name !== 'string') continue;
      calls.push({
        id: typeof fc.id === 'string' ? fc.id : '',
        name: fc.name,
        args:
          fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)
            ? (fc.args as Record<string, unknown>)
            : {},
      });
    }
    if (calls.length > 0) out.toolCalls = calls;
  }
  const cancel = msg.toolCallCancellation as { ids?: unknown } | undefined;
  if (Array.isArray(cancel?.ids)) {
    out.cancelledToolCallIds = cancel.ids.filter((id): id is string => typeof id === 'string');
  }
  const resumption = msg.sessionResumptionUpdate as
    | { newHandle?: string; resumable?: boolean }
    | undefined;
  if (resumption?.resumable && typeof resumption.newHandle === 'string') {
    out.resumptionHandle = resumption.newHandle;
  }
  if (msg.goAway !== undefined) out.goAway = true;
  return out;
}
