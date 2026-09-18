import { describe, expect, it, vi } from 'vitest';
import type { BrowserExtractCandidates } from '../../shared/browser-automation';
import type { JevResult } from '../jev/jev-client';
import {
  coerceExtractDate,
  coerceExtractNumber,
  resolveBrowserExtract,
} from './browser-extract';

const context = {
  url: 'https://example.test/pagina',
  title: 'Página de teste',
  excerpt: 'Trecho visível da página',
};

function candidates(
  overrides: Partial<BrowserExtractCandidates> = {},
): BrowserExtractCandidates {
  return { jsonLd: [], pairs: [], tokens: [], ...overrides };
}

function jevResult(answers: JevResult['answers']): JevResult {
  return { model: 'test-model', answers, usage: { input_tokens: 10, output_tokens: 5 } };
}

const enabled = { jevEnabled: () => true, jevReady: () => true };
const recordDecision = vi.fn();

describe('coerceExtractNumber', () => {
  it('parses pt-BR and en-US numbers', () => {
    expect(coerceExtractNumber('1.234,56')).toBe(1234.56);
    expect(coerceExtractNumber('1,234.56')).toBe(1234.56);
    expect(coerceExtractNumber('R$ 1.234,56')).toBe(1234.56);
    expect(coerceExtractNumber('42')).toBe(42);
    expect(coerceExtractNumber('abc')).toBeNull();
  });
});

describe('coerceExtractDate', () => {
  it('normalizes dd/mm/yyyy, ISO and pt/en month names to ISO', () => {
    expect(coerceExtractDate('12/03/2026')).toBe('2026-03-12');
    expect(coerceExtractDate('2026-03-12T10:00:00Z')).toBe('2026-03-12');
    expect(coerceExtractDate('12 de março de 2026')).toBe('2026-03-12');
    expect(coerceExtractDate('March 12, 2026')).toBe('2026-03-12');
    expect(coerceExtractDate('não é data')).toBe('não é data');
  });
});

describe('resolveBrowserExtract', () => {
  it('resolves a JSON-LD leaf with confidence 1 before candidates', async () => {
    const result = await resolveBrowserExtract(
      candidates({
        jsonLd: [{ preco: '1.234,56' }],
        pairs: [{ label: 'Preço', value: '9.999,00' }],
      }),
      [{ name: 'preco', type: 'number' }],
      context,
      { ...enabled, recordDecision },
    );
    expect(result.fields.preco).toEqual({
      value: 1234.56,
      confidence: 1,
      source: 'json-ld',
    });
    expect(result.jev.calls).toBe(0);
  });

  it('resolves a single pair candidate with confidence 0.8 and coerces', async () => {
    const result = await resolveBrowserExtract(
      candidates({
        pairs: [{ label: 'Total do pedido', value: 'R$ 1.234,56', ref: 'e7' }],
      }),
      [{ name: 'total', type: 'number', hint: 'total do pedido' }],
      context,
      { ...enabled, recordDecision },
    );
    expect(result.fields.total).toEqual({
      value: 1234.56,
      confidence: 0.8,
      source: 'pair',
      ref: 'e7',
    });
  });

  it('returns null with source none when there are no candidates', async () => {
    const result = await resolveBrowserExtract(
      candidates(),
      [{ name: 'inexistente', type: 'string' }],
      context,
      { ...enabled, recordDecision },
    );
    expect(result.fields.inexistente).toEqual({
      value: null,
      confidence: 0,
      source: 'none',
    });
  });

  it('lets Jev pick among multiple candidates and records the decision', async () => {
    recordDecision.mockClear();
    const jev = vi.fn(async (_req: unknown) =>
      jevResult({
        candidate: {
          type: 'choice',
          choice: 'c2',
          probabilities: { c1: 0.2, c2: 0.7, none: 0.1 },
          confidence: 0.8,
        },
      }),
    );
    const result = await resolveBrowserExtract(
      candidates({
        pairs: [
          { label: 'Subtotal', value: '100' },
          { label: 'Total do pedido', value: '120' },
        ],
      }),
      [{ name: 'total', type: 'number' }],
      context,
      { jev, ...enabled, recordDecision },
    );
    expect(jev).toHaveBeenCalledOnce();
    expect(jev.mock.calls[0][0]).toMatchObject({ surface: 'browserTool' });
    expect(result.fields.total).toEqual({
      value: 120,
      confidence: 0.8,
      source: 'jev',
    });
    expect(result.jev.calls).toBe(1);
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'browserTool' }),
    );
  });

  it('returns null when Jev confidence is below 0.6 or picks none', async () => {
    const jev = vi.fn(async (_req: unknown) =>
      jevResult({
        candidate: {
          type: 'choice',
          choice: 'none',
          probabilities: { none: 0.9 },
          confidence: 0.9,
        },
      }),
    );
    const result = await resolveBrowserExtract(
      candidates({
        pairs: [
          { label: 'Total', value: '100' },
          { label: 'Total geral', value: '200' },
        ],
      }),
      [{ name: 'total', type: 'number' }],
      context,
      { jev, ...enabled, recordDecision },
    );
    expect(result.fields.total.source).toBe('none');
    expect(result.fields.total.value).toBeNull();
  });

  it('fails open to null when Jev is unavailable or the surface is disabled', async () => {
    const twoCandidates = candidates({
      pairs: [
        { label: 'Total', value: '100' },
        { label: 'Total geral', value: '200' },
      ],
    });
    const noJudge = await resolveBrowserExtract(
      twoCandidates,
      [{ name: 'total', type: 'number' }],
      context,
      {
        jev: vi.fn(async (_req: unknown) => null),
        ...enabled,
        recordDecision,
      },
    );
    expect(noJudge.fields.total.source).toBe('none');
    expect(noJudge.jev.skipped).toBe('judge-unavailable');

    const disabled = await resolveBrowserExtract(
      twoCandidates,
      [{ name: 'total', type: 'number' }],
      context,
      {
        jev: vi.fn(),
        jevEnabled: () => false,
        jevReady: () => true,
        recordDecision,
      },
    );
    expect(disabled.fields.total.source).toBe('none');
    expect(disabled.jev.skipped).toBe('surface-disabled');

    const noCredential = await resolveBrowserExtract(
      twoCandidates,
      [{ name: 'total', type: 'number' }],
      context,
      {
        jev: vi.fn(),
        jevEnabled: () => true,
        jevReady: () => false,
        recordDecision,
      },
    );
    expect(noCredential.jev.skipped).toBe('no-credential');
  });

  it('stops calling Jev for later fields after the first unavailable answer', async () => {
    const jev = vi.fn(async (_req: unknown) => null);
    const result = await resolveBrowserExtract(
      candidates({
        pairs: [
          { label: 'Total', value: '100' },
          { label: 'Total geral', value: '200' },
          { label: 'Preço', value: '10' },
          { label: 'Preço final', value: '20' },
        ],
      }),
      [
        { name: 'total', type: 'number' },
        { name: 'preço', type: 'number' },
        { name: 'em estoque', type: 'boolean' },
      ],
      context,
      { jev, ...enabled, recordDecision },
    );
    // one attempt only: after judge-unavailable, later fields never ask again
    expect(jev).toHaveBeenCalledOnce();
    expect(result.jev.calls).toBe(0);
    expect(result.jev.skipped).toBe('judge-unavailable');
    expect(result.fields.total.source).toBe('none');
    expect(result.fields['preço'].source).toBe('none');
    expect(result.fields['em estoque'].source).toBe('none');
  });

  it('resolves boolean fields via noul and maps probability to value/confidence', async () => {
    const jev = vi.fn(async (_req: unknown) =>
      jevResult({ answer: { type: 'noul', noul: 0.85 } }),
    );
    const result = await resolveBrowserExtract(
      candidates(),
      [{ name: 'em estoque', type: 'boolean' }],
      context,
      { jev, ...enabled, recordDecision },
    );
    expect(result.fields['em estoque']).toEqual({
      value: true,
      confidence: 0.7,
      source: 'jev',
    });
  });

  it('resolves enum fields via choice among declared options only', async () => {
    const jev = vi.fn(async (_req: unknown) =>
      jevResult({
        option: {
          type: 'choice',
          choice: 'boleto',
          probabilities: { boleto: 0.9 },
          confidence: 0.9,
        },
      }),
    );
    const result = await resolveBrowserExtract(
      candidates(),
      [{ name: 'pagamento', type: 'enum', enum: ['pix', 'boleto', 'cartão'] }],
      context,
      { jev, ...enabled, recordDecision },
    );
    expect(result.fields.pagamento).toEqual({
      value: 'boleto',
      confidence: 0.9,
      source: 'jev',
    });
  });

  it('rejects an enum choice outside the declared options', async () => {
    const jev = vi.fn(async (_req: unknown) =>
      jevResult({
        option: {
          type: 'choice',
          choice: 'dinheiro',
          probabilities: { dinheiro: 0.9 },
          confidence: 0.9,
        },
      }),
    );
    const result = await resolveBrowserExtract(
      candidates(),
      [{ name: 'pagamento', type: 'enum', enum: ['pix', 'boleto'] }],
      context,
      { jev, ...enabled, recordDecision },
    );
    expect(result.fields.pagamento.source).toBe('none');
  });

  it('uses type-compatible tokens as candidates', async () => {
    const result = await resolveBrowserExtract(
      candidates({
        tokens: [{ kind: 'money', text: 'R$ 42,50', context: 'Preço unitário R$ 42,50' }],
      }),
      [{ name: 'preço', type: 'number', hint: 'preço unitário' }],
      context,
      { ...enabled, recordDecision },
    );
    expect(result.fields['preço'].value).toBe(42.5);
    expect(result.fields['preço'].source).toBe('token');
  });
});
