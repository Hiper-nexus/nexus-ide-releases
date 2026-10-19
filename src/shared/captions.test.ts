import { describe, expect, it } from 'vitest';
import {
  buildCaptionCues,
  buildNarrationTimeline,
  cuesToSrt,
  cuesToVtt,
  splitParagraphs,
  wordsFromAlignment,
  type CharacterAlignment,
} from './captions';

/** Alignment as the provider returns it: one entry per character, 50 ms each. */
function alignmentOf(text: string, stepSeconds = 0.05): CharacterAlignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * stepSeconds),
    character_end_times_seconds: characters.map((_, index) => (index + 1) * stepSeconds),
  };
}

describe('wordsFromAlignment', () => {
  it('agrupa caracteres em palavras com início e fim em ms', () => {
    const words = wordsFromAlignment(alignmentOf('Olá Nexus'));
    expect(words).toEqual([
      { text: 'Olá', startMs: 0, endMs: 150 },
      { text: 'Nexus', startMs: 200, endMs: 450 },
    ]);
  });

  it('desloca o trecho para o lugar dele no áudio juntado', () => {
    const words = wordsFromAlignment(alignmentOf('oi'), 1_000);
    expect(words).toEqual([{ text: 'oi', startMs: 1_000, endMs: 1_100 }]);
  });

  it('quebra de linha e espaços repetidos não viram palavra', () => {
    const words = wordsFromAlignment(alignmentOf('a \n\n b'));
    expect(words.map((word) => word.text)).toEqual(['a', 'b']);
  });

  it('listas de tamanhos diferentes não estouram', () => {
    const words = wordsFromAlignment({
      characters: ['a', 'b', 'c'],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1, 0.2, 0.3],
    });
    expect(words).toEqual([{ text: 'ab', startMs: 0, endMs: 200 }]);
  });
});

describe('splitParagraphs', () => {
  it('usa linha em branco quando existe', () => {
    expect(splitParagraphs('Um.\nainda um.\n\nDois.')).toEqual(['Um. ainda um.', 'Dois.']);
  });

  it('sem linha em branco, cada linha é um parágrafo', () => {
    expect(splitParagraphs('Um.\r\nDois.')).toEqual(['Um.', 'Dois.']);
  });

  it('texto vazio não tem parágrafo', () => {
    expect(splitParagraphs('  \n ')).toEqual([]);
  });
});

describe('buildNarrationTimeline', () => {
  const script = 'O Claude abre panes. O Gemini revisa.\n\nTudo no Nexus IDE.';
  const paragraphs = splitParagraphs(script);
  const timed = wordsFromAlignment(alignmentOf(paragraphs.join(' ')));

  it('frases e parágrafos saem do roteiro, com tempos das palavras', () => {
    const timeline = buildNarrationTimeline(paragraphs, timed, 0);
    expect(timeline.sentences.map((sentence) => sentence.text)).toEqual([
      'O Claude abre panes.',
      'O Gemini revisa.',
      'Tudo no Nexus IDE.',
    ]);
    expect(timeline.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'O Claude abre panes. O Gemini revisa.',
      'Tudo no Nexus IDE.',
    ]);
    expect(timeline.sentences[2].paragraph).toBe(1);
    expect(timeline.words[0]).toMatchObject({ i: 0, text: 'O', sentence: 0, paragraph: 0 });
    expect(timeline.words.at(-1)).toMatchObject({ text: 'IDE.', sentence: 2, paragraph: 1 });
    expect(timeline.durationMs).toBe(timeline.words.at(-1)?.endMs);
  });

  it('com a mesma contagem de palavras, a grafia do roteiro vence', () => {
    // O provedor normalizou "IDE" para "ai di i" no texto: o roteiro manda.
    const providerWords = timed.map((word) =>
      word.text === 'Claude' ? { ...word, text: 'Clode' } : word,
    );
    const timeline = buildNarrationTimeline(paragraphs, providerWords, 0);
    expect(timeline.words.map((word) => word.text)).toContain('Claude');
    expect(timeline.words.map((word) => word.text)).not.toContain('Clode');
  });

  it('parágrafo sem ponto final fecha a frase na troca de parágrafo', () => {
    const two = ['Primeiro sem ponto', 'Segundo.'];
    const timeline = buildNarrationTimeline(two, wordsFromAlignment(alignmentOf(two.join(' '))), 0);
    expect(timeline.sentences.map((sentence) => sentence.text)).toEqual([
      'Primeiro sem ponto',
      'Segundo.',
    ]);
  });

  it('a duração do áudio vale quando é maior que a última palavra', () => {
    expect(buildNarrationTimeline(paragraphs, timed, 99_000).durationMs).toBe(99_000);
  });
});

describe('legendas', () => {
  const paragraphs = splitParagraphs(
    'Esta é uma frase bem comprida que precisa ser quebrada em mais de uma legenda curta. Fim.',
  );
  const timeline = buildNarrationTimeline(
    paragraphs,
    wordsFromAlignment(alignmentOf(paragraphs.join(' '), 0.03)),
    0,
  );

  it('fecha a legenda no limite de caracteres e no fim da frase', () => {
    const cues = buildCaptionCues(timeline.words, { maxChars: 32 });
    expect(cues.every((cue) => cue.text.length <= 32)).toBe(true);
    expect(cues.at(-1)?.text).toBe('Fim.');
    expect(cues.map((cue) => cue.text).join(' ')).toBe(paragraphs[0]);
  });

  it('legendas nunca se sobrepõem', () => {
    const cues = buildCaptionCues(timeline.words, { maxChars: 20 });
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index].startMs).toBeGreaterThanOrEqual(cues[index - 1].endMs);
    }
  });

  it('pausa longa abre legenda nova', () => {
    const words = [
      { i: 0, text: 'antes', startMs: 0, endMs: 300, sentence: 0, paragraph: 0 },
      { i: 1, text: 'depois', startMs: 2_000, endMs: 2_400, sentence: 0, paragraph: 0 },
    ];
    expect(buildCaptionCues(words).map((cue) => cue.text)).toEqual(['antes', 'depois']);
  });

  it('SRT com vírgula nos milissegundos e índice desde 1', () => {
    const srt = cuesToSrt([
      { startMs: 0, endMs: 1_500, text: 'Olá' },
      { startMs: 3_723_004, endMs: 3_724_000, text: 'a --> b' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nOlá\n\n' +
        '2\n01:02:03,004 --> 01:02:04,000\na → b\n',
    );
  });

  it('WebVTT com cabeçalho, ponto nos milissegundos e texto escapado', () => {
    const vtt = cuesToVtt([{ startMs: 250, endMs: 1_000, text: 'A <b> & C' }]);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.250 --> 00:00:01.000\nA &lt;b&gt; &amp; C\n');
  });
});
