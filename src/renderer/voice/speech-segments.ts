export interface SpeechSegments {
  first: string;
  rest: string;
}

const FIRST_SEGMENT_MAX_CHARS = 180;

export function splitForPipelinedSpeech(text: string): SpeechSegments {
  const trimmed = text.trim();
  if (!trimmed) return { first: '', rest: '' };
  const sentenceMatch = trimmed.match(/^(.{1,180}?[.!?])\s+(.+)$/s);
  if (sentenceMatch?.[1] && sentenceMatch[2]) {
    return {
      first: sentenceMatch[1].trim(),
      rest: sentenceMatch[2].trim(),
    };
  }
  if (trimmed.length <= FIRST_SEGMENT_MAX_CHARS) {
    return { first: trimmed, rest: '' };
  }
  const slice = trimmed.slice(0, FIRST_SEGMENT_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 80 ? slice.slice(0, lastSpace) : slice;
  return {
    first: cut.trim(),
    rest: trimmed.slice(cut.length).trim(),
  };
}
