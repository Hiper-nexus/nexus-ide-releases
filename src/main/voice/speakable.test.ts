import { describe, expect, it } from 'vitest';
import { cleanText, splitSentences, toSpeakable } from './speakable';

describe('cleanText', () => {
  it('strips ANSI escape codes', () => {
    expect(cleanText('\x1b[31mhello\x1b[0m world')).toBe('hello world');
  });

  it('removes fenced and inline code', () => {
    const raw = 'Here is code:\n```js\nconst x = 1;\n```\nand `inline` too.';
    const cleaned = cleanText(raw);
    expect(cleaned).not.toContain('const x');
    expect(cleaned).not.toContain('inline');
    expect(cleaned).toContain('Here is code');
  });

  it('collapses whitespace and trims prompt noise', () => {
    expect(cleanText('  $ foo   bar  ')).toBe('foo bar');
  });

  it('strips a bare mcp__ tool call with args', () => {
    const out = cleanText('Feito. mcp__overclock__handoff_list({ids:["h-5t"]}) pronto.');
    expect(out).not.toMatch(/mcp__|handoff_list|\{|\}/);
    expect(out).toContain('Feito.');
    expect(out).toContain('pronto.');
  });

  it('strips a bare mcp__ tool name without args', () => {
    const out = cleanText('Use mcp__nexus_git_status agora.');
    expect(out).not.toContain('mcp__');
    expect(out).toBe('Use agora.');
  });

  it('strips a bare JSON payload blob', () => {
    const out = cleanText('Resultado {"status":"ok","id":42} salvo.');
    expect(out).not.toMatch(/\{|status|"ok"/);
    expect(out).toContain('Resultado');
    expect(out).toContain('salvo.');
  });

  it('strips an orphaned "Mais detalhes:" pointer left after the mcp call is removed', () => {
    const out = cleanText(
      'Handoff entregue. Mais detalhes: mcp__overclock__handoff_list({ids:["h-5t"]})',
    );
    expect(out).not.toMatch(/Mais detalhes|mcp__|\{/);
    expect(out).toContain('Handoff entregue.');
  });

  it('keeps "Mais detalhes" when it is real prose, not an orphan pointer', () => {
    const out = cleanText('Mais detalhes sobre o deploy estão no pane.');
    expect(out).toBe('Mais detalhes sobre o deploy estão no pane.');
  });

  it('unwinds shallow nested JSON across passes', () => {
    const out = cleanText('Antes {"a":{"b":1},"c":2} depois.');
    expect(out).not.toContain('{');
    expect(out).toContain('Antes');
    expect(out).toContain('depois.');
  });
});

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
});

describe('toSpeakable', () => {
  it('returns empty for mode off', () => {
    expect(toSpeakable('anything at all here', 'off')).toBe('');
  });

  it('summary keeps at most three sentences', () => {
    const raw = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const out = toSpeakable(raw, 'summary');
    expect(out).toContain('First sentence.');
    expect(out).toContain('Third sentence.');
    expect(out).not.toContain('Fourth sentence.');
  });

  it('summary caps very long single sentences with an ellipsis', () => {
    const long = `${'word '.repeat(120)}.`;
    const out = toSpeakable(long, 'summary');
    expect(out.length).toBeLessThanOrEqual(242);
    expect(out.endsWith('…')).toBe(true);
  });

  it('summary of a code-only response returns a generic spoken line', () => {
    const out = toSpeakable('```js\nconst x = 1;\nconst y = 2;\n```', 'summary');
    expect(out).toBe('Pronto. A resposta é quase toda código — veja o pane.');
  });

  it('returns empty when there is nothing meaningful and no code', () => {
    expect(toSpeakable('   \n\n   ', 'summary')).toBe('');
  });

  it('full mode returns cleaned text without sentence limiting', () => {
    const raw = 'Alpha. Beta. Gamma. Delta. Epsilon.';
    expect(toSpeakable(raw, 'full')).toBe('Alpha. Beta. Gamma. Delta. Epsilon.');
  });
});
