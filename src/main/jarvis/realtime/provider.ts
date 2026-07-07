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
  role: RealtimeTranscriptRole;
  text: string;
  final: boolean;
}

export interface RoleAwareRealtimeProvider extends RealtimeProvider {
  onRoleTranscript(cb: (event: RealtimeTranscriptEvent) => void): void;
}

export interface TurnManagedRealtimeProvider extends RoleAwareRealtimeProvider {
  readonly isReady: boolean;
  endUserTurn(): void;
  sendContext(text: string): void;
  sendText(text: string): void;
  onInterrupted(cb: () => void): void;
  onResponseDone(cb: () => void): void;
}

export type RealtimeProviderId = 'openai' | 'gemini';

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
