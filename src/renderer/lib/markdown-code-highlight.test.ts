import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKDOWN_HIGHLIGHT_MAX_CHARS,
  MARKDOWN_HIGHLIGHT_MAX_LINES,
  markdownHighlightLanguage,
  withHighlightTimeout,
} from './markdown-code-highlight';

afterEach(() => vi.useRealTimers());

describe('markdownHighlightLanguage', () => {
  it('normaliza apelidos de cerca para a linguagem do Shiki', () => {
    expect(markdownHighlightLanguage('ts', 'const a = 1;')).toBe('typescript');
    expect(markdownHighlightLanguage('TSX', 'x')).toBe('tsx');
    expect(markdownHighlightLanguage('sh', 'ls')).toBe('shellscript');
    expect(markdownHighlightLanguage('py', 'x')).toBe('python');
    expect(markdownHighlightLanguage('c++', 'x')).toBe('cpp');
    expect(markdownHighlightLanguage('yml', 'a: 1')).toBe('yaml');
  });

  it('não realça sem linguagem, com linguagem desconhecida nem Mermaid', () => {
    expect(markdownHighlightLanguage('', 'x')).toBeNull();
    expect(markdownHighlightLanguage('cobolzinho', 'x')).toBeNull();
    expect(markdownHighlightLanguage('mermaid', 'graph TD')).toBeNull();
    expect(markdownHighlightLanguage('__proto__', 'x')).toBeNull();
    expect(markdownHighlightLanguage('text', 'x')).toBeNull();
  });

  it('respeita o teto de tamanho (caracteres e linhas)', () => {
    expect(markdownHighlightLanguage('ts', 'a'.repeat(MARKDOWN_HIGHLIGHT_MAX_CHARS))).toBe('typescript');
    expect(markdownHighlightLanguage('ts', 'a'.repeat(MARKDOWN_HIGHLIGHT_MAX_CHARS + 1))).toBeNull();
    const lines = (count: number) => Array.from({ length: count }, () => 'x').join('\n');
    expect(markdownHighlightLanguage('ts', lines(MARKDOWN_HIGHLIGHT_MAX_LINES))).toBe('typescript');
    expect(markdownHighlightLanguage('ts', lines(MARKDOWN_HIGHLIGHT_MAX_LINES + 1))).toBeNull();
  });
});

describe('withHighlightTimeout', () => {
  it('devolve o carregamento que chega a tempo', async () => {
    await expect(withHighlightTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('desiste quando o carregamento demora', async () => {
    vi.useFakeTimers();
    const pending = withHighlightTimeout(new Promise<string>(() => {}), 50);
    const settled = expect(pending).rejects.toThrow(/demorou/);
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  it('propaga a falha do carregamento', async () => {
    await expect(withHighlightTimeout(Promise.reject(new Error('chunk')), 50)).rejects.toThrow('chunk');
  });
});
