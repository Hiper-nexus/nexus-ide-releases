/**
 * Narration timeline and captions (F-1591). Pure: no I/O, no clock.
 *
 * The TTS returns the start and end of every CHARACTER of the text it spoke
 * (ElevenLabs `/with-timestamps`). This module turns that into words,
 * sentences and paragraphs with times in ms, and into SRT/WebVTT cues. The
 * words keep the spelling of the script: recognition only ever supplies time,
 * never text (lesson of the 19/10 prototype: ASR wrote "Clode" for Claude).
 */

export interface CharacterAlignment {
  readonly characters: readonly string[];
  readonly character_start_times_seconds: readonly number[];
  readonly character_end_times_seconds: readonly number[];
}

export interface TimedWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface TimelineWord extends TimedWord {
  readonly i: number;
  readonly sentence: number;
  readonly paragraph: number;
}

export interface TimelineSpan {
  readonly i: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly firstWord: number;
  readonly lastWord: number;
}

export interface TimelineSentence extends TimelineSpan {
  readonly paragraph: number;
}

export interface NarrationTimelineBody {
  readonly durationMs: number;
  readonly words: readonly TimelineWord[];
  readonly sentences: readonly TimelineSentence[];
  readonly paragraphs: readonly TimelineSpan[];
}

export interface CaptionCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface CaptionOptions {
  /** Longest cue line. 42 is the usual broadcast limit; vertical video wants less. */
  readonly maxChars?: number;
  readonly maxDurationMs?: number;
  /** A pause longer than this starts a new cue. */
  readonly maxGapMs?: number;
}

const WHITESPACE = /\s/u;

function ms(seconds: number | undefined): number {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : 0;
}

/**
 * Consecutive non-whitespace characters become one word. `offsetMs` shifts a
 * chunk to its place in the concatenated audio.
 */
export function wordsFromAlignment(
  alignment: CharacterAlignment,
  offsetMs = 0,
): TimedWord[] {
  const words: TimedWord[] = [];
  const count = Math.min(
    alignment.characters.length,
    alignment.character_start_times_seconds.length,
    alignment.character_end_times_seconds.length,
  );
  let text = '';
  let start = 0;
  let end = 0;
  const flush = (): void => {
    if (!text) return;
    words.push({
      text,
      startMs: start + offsetMs,
      endMs: Math.max(start, end) + offsetMs,
    });
    text = '';
  };
  for (let index = 0; index < count; index += 1) {
    const character = alignment.characters[index] ?? '';
    if (character === '' || WHITESPACE.test(character)) {
      flush();
      continue;
    }
    if (!text) start = ms(alignment.character_start_times_seconds[index]);
    end = ms(alignment.character_end_times_seconds[index]);
    text += character;
  }
  flush();
  return words;
}

/** Paragraphs are separated by blank lines; without any, by line breaks. */
export function splitParagraphs(script: string): string[] {
  const normalized = script.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return [];
  const separator = /\n[ \t]*\n/u.test(normalized) ? /\n[ \t]*\n+/u : /\n+/u;
  return normalized
    .split(separator)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

function scriptWords(paragraph: string): string[] {
  return paragraph.split(/\s+/u).filter(Boolean);
}

/** A word that ends a sentence: terminal punctuation, maybe inside quotes. */
function endsSentence(word: string): boolean {
  return /[.!?…]["'”’»)\]]*$/u.test(word);
}

function normWord(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Give every SCRIPT word a time from the timed words, even when the two lists
 * do not split the same way: a provider (or a recognizer) may split
 * "nexuside.app" in two, join two words, or drop punctuation. Walks both
 * lists in order, matching normalized text, merging up to 4 timed words into
 * one script word or splitting one timed word over up to 4 script words; an
 * unmatched pair takes the timed word's time and both lists advance.
 */
export function alignScriptWords(script: readonly string[], timed: readonly TimedWord[]): TimedWord[] {
  const out: TimedWord[] = [];
  if (timed.length === 0) return script.map((text) => ({ text, startMs: 0, endMs: 0 }));
  let j = 0;
  let i = 0;
  const last = timed[timed.length - 1];
  while (i < script.length) {
    if (j >= timed.length) {
      out.push({ text: script[i], startMs: last.endMs, endMs: last.endMs });
      i += 1;
      continue;
    }
    const target = normWord(script[i]);
    if (target === normWord(timed[j].text)) {
      out.push({ text: script[i], startMs: timed[j].startMs, endMs: timed[j].endMs });
      i += 1;
      j += 1;
      continue;
    }
    // Several timed words make one script word ("nexuside" + "app").
    let merged = false;
    let joined = normWord(timed[j].text);
    for (let k = j + 1; k < Math.min(timed.length, j + 4) && joined.length < target.length; k += 1) {
      joined += normWord(timed[k].text);
      if (joined === target) {
        out.push({ text: script[i], startMs: timed[j].startMs, endMs: timed[k].endMs });
        i += 1;
        j = k + 1;
        merged = true;
        break;
      }
    }
    if (merged) continue;
    // One timed word covers several script words: split its time evenly.
    const spoken = normWord(timed[j].text);
    let combined = target;
    let split = false;
    for (let m = i + 1; m < Math.min(script.length, i + 4) && combined.length < spoken.length; m += 1) {
      combined += normWord(script[m]);
      if (combined === spoken) {
        const count = m - i + 1;
        const step = (timed[j].endMs - timed[j].startMs) / count;
        for (let n = 0; n < count; n += 1) {
          out.push({
            text: script[i + n],
            startMs: Math.round(timed[j].startMs + step * n),
            endMs: Math.round(timed[j].startMs + step * (n + 1)),
          });
        }
        i = m + 1;
        j += 1;
        split = true;
        break;
      }
    }
    if (split) continue;
    out.push({ text: script[i], startMs: timed[j].startMs, endMs: timed[j].endMs });
    i += 1;
    j += 1;
  }
  return out;
}

/**
 * Build the timeline from the paragraphs of the script and the timed words of
 * the audio. The words are always the SCRIPT's words with the script's
 * spelling; the audio only supplies their times (`alignScriptWords`).
 */
export function buildNarrationTimeline(
  paragraphs: readonly string[],
  timedWords: readonly TimedWord[],
  durationMs: number,
): NarrationTimelineBody {
  const expected: Array<{ text: string; paragraph: number }> = [];
  paragraphs.forEach((paragraph, index) => {
    for (const word of scriptWords(paragraph)) expected.push({ text: word, paragraph: index });
  });
  const timed = alignScriptWords(
    expected.map((word) => word.text),
    timedWords,
  );

  const words: TimelineWord[] = [];
  const sentences: TimelineSentence[] = [];
  let sentenceStart = 0;
  let sentenceIndex = 0;
  for (let index = 0; index < timed.length; index += 1) {
    const source = timed[index];
    const paragraph = expected[index]?.paragraph ?? 0;
    const text = source.text;
    words.push({
      i: index,
      text,
      startMs: source.startMs,
      endMs: source.endMs,
      sentence: sentenceIndex,
      paragraph,
    });
    const nextParagraph = expected[index + 1]?.paragraph;
    const lastWord = index === timed.length - 1;
    if (endsSentence(text) || lastWord || (nextParagraph !== undefined && nextParagraph !== paragraph)) {
      const span = words.slice(sentenceStart, index + 1);
      sentences.push({
        i: sentenceIndex,
        text: span.map((word) => word.text).join(' '),
        startMs: span[0].startMs,
        endMs: span[span.length - 1].endMs,
        firstWord: sentenceStart,
        lastWord: index,
        paragraph,
      });
      sentenceIndex += 1;
      sentenceStart = index + 1;
      // Words already pushed keep the index of the sentence they closed.
    }
  }

  const paragraphSpans: TimelineSpan[] = [];
  let first = 0;
  while (first < words.length) {
    const paragraph = words[first].paragraph;
    let last = first;
    while (last + 1 < words.length && words[last + 1].paragraph === paragraph) last += 1;
    const span = words.slice(first, last + 1);
    paragraphSpans.push({
      i: paragraphSpans.length,
      text: span.map((word) => word.text).join(' '),
      startMs: span[0].startMs,
      endMs: span[span.length - 1].endMs,
      firstWord: first,
      lastWord: last,
    });
    first = last + 1;
  }
  // Paragraph indexes in words/sentences follow the script; renumber them to
  // the spans actually present (an empty paragraph never produces a span).
  const remap = new Map<number, number>();
  paragraphSpans.forEach((span) => remap.set(words[span.firstWord].paragraph, span.i));
  const renumber = (paragraph: number): number => remap.get(paragraph) ?? paragraph;

  return {
    durationMs: Math.max(durationMs, words.at(-1)?.endMs ?? 0),
    words: words.map((word) => ({ ...word, paragraph: renumber(word.paragraph) })),
    sentences: sentences.map((sentence) => ({
      ...sentence,
      paragraph: renumber(sentence.paragraph),
    })),
    paragraphs: paragraphSpans,
  };
}

/**
 * Group words into caption cues: a cue closes at the end of a sentence, before
 * a long pause, or when it would grow past the line or duration limit. Cues
 * never overlap.
 */
export function buildCaptionCues(
  words: readonly TimelineWord[],
  options: CaptionOptions = {},
): CaptionCue[] {
  const maxChars = options.maxChars ?? 42;
  const maxDurationMs = options.maxDurationMs ?? 4_000;
  const maxGapMs = options.maxGapMs ?? 600;
  const cues: CaptionCue[] = [];
  let current: TimelineWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    cues.push({
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: current.map((word) => word.text).join(' '),
    });
    current = [];
  };
  for (const word of words) {
    if (current.length > 0) {
      const last = current[current.length - 1];
      const text = `${current.map((item) => item.text).join(' ')} ${word.text}`;
      if (
        word.sentence !== last.sentence ||
        word.startMs - last.endMs > maxGapMs ||
        text.length > maxChars ||
        word.endMs - current[0].startMs > maxDurationMs
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    const end = next ? Math.min(cue.endMs, next.startMs) : cue.endMs;
    return { ...cue, endMs: Math.max(cue.startMs, end) };
  });
}

function clock(totalMs: number, separator: ',' | '.'): string {
  const value = Math.max(0, Math.round(totalMs));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  const pad = (number: number, width = 2) => String(number).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

/** A cue line may not contain the timing arrow nor an empty line. */
function cueText(text: string): string {
  return text.replace(/-->/gu, '→').replace(/\s*\n\s*/gu, ' ').trim();
}

export function cuesToSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${clock(cue.startMs, ',')} --> ${clock(cue.endMs, ',')}\n${cueText(cue.text)}\n`,
    )
    .join('\n');
}

export function cuesToVtt(cues: readonly CaptionCue[]): string {
  const escape = (text: string) =>
    cueText(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  const body = cues
    .map((cue) => `${clock(cue.startMs, '.')} --> ${clock(cue.endMs, '.')}\n${escape(cue.text)}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
