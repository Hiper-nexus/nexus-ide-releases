export interface RealtimeProvider {
  connect(): Promise<void>;
  sendAudioChunk(pcm16: Int16Array): void;
  onTranscript(cb: (delta: string, final: boolean) => void): void;
  onAudioOut(cb: (pcm16: Int16Array) => void): void;
  onError(cb: (err: Error) => void): void;
  interrupt(): void;
  close(): void;
}

export type RealtimeTranscriptRole = 'user' | 'assistant';

export interface RealtimeTranscriptEvent {
  turnId?: string;
  role: RealtimeTranscriptRole;
  text: string;
  final: boolean;
}

export interface RealtimeToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeToolCallEvent {
  callId: string;
  name: string;
  argumentsJson: string;
  arguments: Record<string, unknown>;
}

export interface RoleAwareRealtimeProvider extends RealtimeProvider {
  onRoleTranscript(cb: (event: RealtimeTranscriptEvent) => void): void;
}

export interface TurnManagedRealtimeProvider extends RoleAwareRealtimeProvider {
  readonly isReady: boolean;
  /** True when sendContext is guaranteed not to start/interleave a user turn. */
  readonly supportsPassiveContextUpdates?: boolean;
  /** Binds subsequent transcript callbacks to one renderer conversation turn. */
  beginUserTurn?(turnId: string): void;
  /**
   * Nova ativação reaproveitando o socket quente: zera só o estado local do
   * turno anterior (nada vai ao fio).
   */
  resetTurn?(): void;
  /**
   * Prova de vida do socket quente: resolve true se o servidor respondeu dentro
   * de `timeoutMs`. Um provider sem ela (Gemini Live) nunca é reutilizado no
   * wake: o controller reconecta, porque um socket aberto localmente pode estar
   * morto no servidor.
   */
  probeLiveness?(timeoutMs: number): Promise<boolean>;
  endUserTurn(): void;
  /** Force commit + response for a locally-ended turn even with server VAD. */
  forceEndUserTurn?(): void;
  sendContext(text: string): void;
  sendText(text: string): void;
  sendToolResult(callId: string, output: unknown): void;
  /**
   * Uma resposta segue em curso (ou acabou de ser pedida) depois do último
   * `response.done`: o `done` que chegou era o da resposta que FEZ a chamada de
   * ferramenta, e a resposta de seguimento ainda vai falar. Quem fecha o turno
   * de ferramenta espera o próximo `done`. Ausente = sem essa distinção (Gemini).
   */
  readonly responseInFlight?: boolean;
  /** Gemini function responses require the original declaration name. */
  sendNamedToolResult?(callId: string, name: string, output: unknown): void;
  onToolCall(cb: (event: RealtimeToolCallEvent) => void): void;
  /** Provider revoked a previously emitted function call (Gemini Live). */
  onToolCallCancelled?(cb: (callId: string) => void): void;
  onInterrupted(cb: () => void): void;
  onResponseDone(cb: () => void): void;
  onDisconnected(cb: (err: Error) => void): void;
  /** Coalesced screen update: debounced + deduped. Fallback = sendContext. */
  sendScreenUpdate?(text: string): void;
}

export type RealtimeProviderId = 'grok' | 'openai' | 'gemini';

export function int16ArrayToBase64(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
    'base64',
  );
}

export function base64ToInt16Array(base64: string): Int16Array {
  const bytes = Buffer.from(base64, 'base64');
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Int16Array(copy);
}

export function resamplePcm16(
  input: Int16Array,
  sourceRate: number,
  targetRate: number,
): Int16Array {
  if (sourceRate === targetRate || input.length === 0) return input;
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Int16Array(outputLength);
  const scale = input.length > 1 ? (input.length - 1) / Math.max(1, outputLength - 1) : 0;
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * scale;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const mix = sourceIndex - left;
    output[i] = Math.round(input[left] * (1 - mix) + input[right] * mix);
  }
  return output;
}
