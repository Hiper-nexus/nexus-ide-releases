import { describe, expect, it } from 'vitest';
import { buildNarrationTimeline, splitParagraphs, type TimedWord } from './captions';
import { alignScriptToSpeech, foldWord, wordSimilarity } from './script-alignment';

/**
 * F-1602 — roteiro × fala reconhecida. A fixture é a saída REAL do Parakeet
 * TDT 0.6B v3 (hyperframes transcribe 0.8.177, 19/10) para uma narração pt-BR
 * de 26 s: tempos certos, grafia errada ("Nexus Cide", "Clôde", "Zemini",
 * "pen", "Nexus e de ponto app").
 */

const SCRIPT = [
  'O NexusIDE coloca vários agentes de código para trabalhar juntos.',
  'O Claude escreve, o Codex revisa e o Gemini testa, cada um no seu pane.',
  'Você acompanha tudo ao vivo e decide o que entra.',
  'Agora ele também faz o vídeo de apresentação do seu produto, com narração e legenda.',
  'Baixe em nexuside.app e comece hoje.',
].join('\n\n');

const PARAKEET: TimedWord[] = ([["O",0,160],["Nexus",160,640],["Cide",640,960],["coloca",1200,1680],["vários",1680,2160],["agentes",2160,2720],["de",2720,2880],["código",2880,3520],["para",3520,3760],["trabalhar",3760,4400],["juntos.",4400,5520],["O",5520,5760],["Clôde",5760,6400],["escreve,",6400,7040],["o",7040,7200],["Codex",7200,7840],["revisa",7840,8240],["e",8240,8320],["o",8320,8480],["Zemini",8480,9120],["testa,",9120,9760],["cada",9760,10080],["um",10080,10320],["no",10320,10480],["seu",10480,10720],["pen.",10720,11680],["Você",11840,12160],["acompanha",12160,12960],["tudo",12960,13200],["ao",13200,13440],["vivo",13440,13760],["e",13760,13920],["decide",13920,14400],["o",14400,14560],["que",14560,14800],["entra.",14800,15680],["Agora",15920,16400],["ele",16400,16720],["também",16800,17120],["faz",17120,17440],["o",17440,17600],["vídeo",17600,17920],["de",17920,18160],["apresentação",18160,18960],["do",18960,19120],["seu",19120,19360],["produto,",19360,20160],["com",20160,20400],["narração",20400,20960],["e",20960,21120],["legenda.",21120,22080],["Baixe",22320,22880],["em",22880,23120],["Nexus",23120,23680],["e",23680,23760],["de",23760,23920],["ponto",23920,24160],["app",24240,24320],["e",24640,24720],["comece",24720,25360],["hoje.",25360,26160]] as Array<[string, number, number]>).map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

const words = (script: string) => splitParagraphs(script).flatMap((paragraph) => paragraph.split(/\s+/u));

describe('alinhamento do roteiro com a fala reconhecida', () => {
  it('a grafia é a do roteiro e os nomes errados pelo reconhecimento pegam o tempo certo', () => {
    const script = words(SCRIPT);
    const result = alignScriptToSpeech(script, PARAKEET);
    expect(result.words.map((word) => word.text)).toEqual(script);
    const timeOf = (text: string) => result.words.find((word) => word.text === text)!;
    expect(timeOf('NexusIDE')).toMatchObject({ startMs: 160, endMs: 960 });
    expect(timeOf('coloca')).toMatchObject({ startMs: 1200, endMs: 1680 });
    expect(timeOf('Claude')).toMatchObject({ startMs: 5760, endMs: 6400 });
    expect(timeOf('Gemini')).toMatchObject({ startMs: 8480, endMs: 9120 });
    expect(timeOf('pane.')).toMatchObject({ startMs: 10720, endMs: 11680 });
    expect(timeOf('nexuside.app')).toMatchObject({ startMs: 23120, endMs: 24320 });
    expect(timeOf('comece')).toMatchObject({ startMs: 24720, endMs: 25360 });
    expect(timeOf('hoje.')).toMatchObject({ startMs: 25360, endMs: 26160 });
    expect(result.unmatched).toBe(0);
    expect(result.extraSpoken).toBe(0);
    expect(result.matchedRatio).toBeGreaterThan(0.9);
  });

  it('a linha do tempo inteira sai com as frases do roteiro', () => {
    const paragraphs = splitParagraphs(SCRIPT);
    const aligned = alignScriptToSpeech(words(SCRIPT), PARAKEET);
    const timeline = buildNarrationTimeline(paragraphs, aligned.words, 26_160);
    expect(timeline.sentences.map((sentence) => sentence.text)).toEqual(paragraphs);
    expect(timeline.sentences.map((sentence) => sentence.startMs)).toEqual([0, 5520, 11840, 15920, 22320]);
  });

  it('palavra improvisada fica de fora e palavra do roteiro não dita recebe o intervalo dos vizinhos', () => {
    const spoken: TimedWord[] = [
      { text: 'bom', startMs: 0, endMs: 300 },
      { text: 'dia', startMs: 300, endMs: 600 },
      { text: 'tipo', startMs: 600, endMs: 900 },
      { text: 'pessoal', startMs: 900, endMs: 1400 },
    ];
    const result = alignScriptToSpeech(['Bom', 'dia,', 'querido', 'pessoal!'], spoken);
    expect(result.words).toEqual([
      { text: 'Bom', startMs: 0, endMs: 300 },
      { text: 'dia,', startMs: 300, endMs: 600 },
      { text: 'querido', startMs: 600, endMs: 900 },
      { text: 'pessoal!', startMs: 900, endMs: 1400 },
    ]);
    const skipped = alignScriptToSpeech(['um', 'dois', 'três', 'quatro'], [
      { text: 'um', startMs: 0, endMs: 200 },
      { text: 'quatro', startMs: 1000, endMs: 1200 },
    ]);
    expect(skipped.unmatched).toBe(2);
    expect(skipped.words[1]).toEqual({ text: 'dois', startMs: 200, endMs: 1000 });
    expect(skipped.words[3]).toEqual({ text: 'quatro', startMs: 1000, endMs: 1200 });
  });

  it('uma palavra falada cobre duas do roteiro, repartindo o tempo pelas letras', () => {
    const result = alignScriptToSpeech(['e-mail', 'marketing'], [{ text: 'emailmarketing', startMs: 0, endMs: 1400 }]);
    expect(result.words[0]).toEqual({ text: 'e-mail', startMs: 0, endMs: 500 });
    expect(result.words[1]).toEqual({ text: 'marketing', startMs: 500, endMs: 1400 });
  });

  it('áudio que não é deste roteiro dá baixa correspondência', () => {
    const result = alignScriptToSpeech(words(SCRIPT), [
      { text: 'receita', startMs: 0, endMs: 500 },
      { text: 'de', startMs: 500, endMs: 600 },
      { text: 'bolo', startMs: 600, endMs: 900 },
    ]);
    expect(result.matchedRatio).toBeLessThan(0.2);
  });

  it('dobra acento, caixa e pontuação; similaridade por letras', () => {
    expect(foldWord('Clôde!')).toBe('clode');
    expect(wordSimilarity('claude', 'clode')).toBeCloseTo(0.667, 2);
    expect(wordSimilarity('', '')).toBe(1);
  });

  it('narração longa roda na banda diagonal sem matriz inteira', () => {
    const many = Array.from({ length: 3_000 }, (_, index) => `palavra${index}`);
    const spoken = many.map((text, index) => ({ text, startMs: index * 300, endMs: index * 300 + 250 }));
    const started = Date.now();
    const result = alignScriptToSpeech(many, spoken);
    expect(result.matchedRatio).toBe(1);
    expect(result.words[2_999]).toEqual({ text: 'palavra2999', startMs: 899_700, endMs: 899_950 });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
