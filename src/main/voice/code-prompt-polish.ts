/**
 * Modo CODE do ditado: a fala vira o prompt que o operador queria digitar.
 *
 * A STT sozinha não entrega isso. O Grok Voice (xAI) só transcreve, então o
 * CODE saía em português (chip CODE·PT); o Whisper traduz literal, com
 * hesitação, repetição e jargão mutilado. Esta passada de texto, depois da
 * STT, reescreve em inglês claro para um agente de código, sem inventar nada.
 *
 * Falha nunca perde ditado: sem chave, timeout ou saída suspeita, o texto da
 * STT segue como veio.
 */
import { DICTATION_CODE_VOCABULARY } from '../../shared/dictation-vocabulary';
import {
  chatOnce,
  chatViaBrainChain,
  defaultBrainDeps,
  type BrainDeps,
} from './jarvis-brain';

export const CODE_PROMPT_POLISH_TIMEOUT_MS = 8_000;
const XAI_CHAT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const XAI_POLISH_MODEL = 'grok-4-fast';
const MAX_POLISH_TOKENS = 1_200;

export const CODE_PROMPT_POLISH_INSTRUCTIONS = [
  "You turn a developer's spoken dictation into the prompt they meant to type to an AI coding agent in a terminal.",
  'The input comes from speech-to-text, usually Brazilian Portuguese, and may contain recognition errors, filler words and self-corrections.',
  '',
  'Rules:',
  '- Write clear, natural English. Keep the speaker\'s intent and scope exactly.',
  '- Keep every concrete detail verbatim: file names, paths, identifiers, commands, flags, numbers, URLs, error messages, product names. Never translate code or commands.',
  '- Fix technical terms the recognizer mangled, using context (e.g. "comita" -> commit, "pull request", "worktree").',
  '- Drop filler, false starts and repetitions. When the speaker corrects themselves, keep only the final version.',
  '- Use the imperative, addressed to the agent. Several asks become short numbered steps in the order spoken; a single ask stays one or two sentences.',
  '- Do not add requirements, steps, assumptions, explanations or politeness that were not spoken. Do not answer or carry out the request. Keep ambiguity instead of guessing.',
  '- A short reply (yes, no, continue, an option number) stays a short reply in English.',
  '',
  `Domain vocabulary: ${DICTATION_CODE_VOCABULARY.join(', ')}.`,
  '',
  'Return only JSON: {"prompt": "<the prompt>"}',
].join('\n');

export interface CodePromptPolishResult {
  readonly text: string;
  readonly polished: boolean;
  readonly reason?: string;
}

type ChatFn = (
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
) => Promise<string>;

/** Brain chain (Gemini → OpenAI → Groq), then Grok with the STT's xAI key. */
function defaultChat(deps: BrainDeps): ChatFn {
  return async (messages, signal) => {
    try {
      return await chatViaBrainChain(messages, MAX_POLISH_TOKENS, deps, signal);
    } catch (brainError) {
      if (signal.aborted) throw brainError;
      const key = deps.getKey('XAI_API_KEY');
      if (!key) throw brainError;
      return chatOnce(
        XAI_CHAT_ENDPOINT,
        key,
        XAI_POLISH_MODEL,
        messages,
        deps,
        true,
        MAX_POLISH_TOKENS,
        signal,
      );
    }
  };
}

/** Pulls the prompt out of the model reply; null when it is not usable. */
export function parsePolishedPrompt(raw: string): string | null {
  let body = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(body);
  if (fenced) body = fenced[1]!.trim();
  try {
    const parsed = JSON.parse(body) as { prompt?: unknown };
    return typeof parsed.prompt === 'string' && parsed.prompt.trim()
      ? parsed.prompt.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * A rewrite far longer than what was spoken is the model adding work the
 * operator never asked for. Numbered steps and English wording grow a little;
 * this bound only rejects runaway output.
 */
export function polishLooksInvented(source: string, polished: string): boolean {
  return polished.length > source.length * 3 + 240;
}

export async function polishCodePrompt(
  transcript: string,
  options: {
    readonly chat?: ChatFn;
    readonly deps?: BrainDeps;
    readonly timeoutMs?: number;
  } = {},
): Promise<CodePromptPolishResult> {
  const source = transcript.trim();
  if (!source) return { text: transcript, polished: false, reason: 'empty' };
  const chat = options.chat ?? defaultChat(options.deps ?? defaultBrainDeps);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('polish timeout')),
    options.timeoutMs ?? CODE_PROMPT_POLISH_TIMEOUT_MS,
  );
  try {
    const raw = await chat(
      [
        { role: 'system', content: CODE_PROMPT_POLISH_INSTRUCTIONS },
        { role: 'user', content: source },
      ],
      controller.signal,
    );
    const polished = parsePolishedPrompt(raw);
    if (!polished) return { text: transcript, polished: false, reason: 'unparseable' };
    if (polishLooksInvented(source, polished)) {
      return { text: transcript, polished: false, reason: 'too-long' };
    }
    return { text: polished, polished: true };
  } catch (error) {
    return {
      text: transcript,
      polished: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
