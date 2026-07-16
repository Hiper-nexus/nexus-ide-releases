// Derived from can1357/oh-my-pi@03c48d073 review pipeline (MIT)
import { describe, expect, it } from 'vitest';
import {
  parseReviewFindings,
  ReviewFindingsParseError,
} from './review-findings';

const VALID_FINDING = {
  title: 'Valide o tamanho do input antes do memcpy',
  body:
    'Quando data.length > BUFFER_SIZE, o memcpy escreve além do buffer, ' +
    'corrompendo o heap com payloads grandes da API.',
  priority: 'P0',
  confidence: 0.9,
  file: 'src/net/buffer.c',
  lineStart: 42,
  lineEnd: 44,
};

const VALID_PAYLOAD = {
  verdict: 'incorrect',
  explanation: 'Overflow de buffer introduzido no patch.',
  confidence: 0.85,
  findings: [VALID_FINDING],
};

describe('parseReviewFindings', () => {
  it('aceita o objeto ReviewFindings direto', () => {
    const parsed = parseReviewFindings(VALID_PAYLOAD);
    expect(parsed.verdict).toBe('incorrect');
    expect(parsed.explanation).toBe(VALID_PAYLOAD.explanation);
    expect(parsed.confidence).toBe(0.85);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      title: VALID_FINDING.title,
      priority: 'P0',
      file: 'src/net/buffer.c',
      lineStart: 42,
      lineEnd: 44,
    });
  });

  it('extrai o JSON de um bloco ```json dentro do summary', () => {
    const summary =
      'Review concluído; 1 finding bloqueador.\n\n' +
      '```json\n' +
      `${JSON.stringify(VALID_PAYLOAD, null, 2)}\n` +
      '```\n' +
      'Detalhes acima.';
    const parsed = parseReviewFindings(summary);
    expect(parsed.verdict).toBe('incorrect');
    expect(parsed.findings[0].priority).toBe('P0');
  });

  it('extrai o objeto do handoff completo (summary + artifacts)', () => {
    const handoff = {
      id: 'handoff-1',
      status: 'success',
      summary: 'Veredito consolidado do review em artifacts.',
      artifacts: [{ kind: 'texto irrelevante' }, VALID_PAYLOAD],
    };
    const parsed = parseReviewFindings(handoff);
    expect(parsed.verdict).toBe('incorrect');
    expect(parsed.findings).toHaveLength(1);
  });

  it('aceita as chaves snake_case do schema original do omp', () => {
    const parsed = parseReviewFindings({
      overall_correctness: 'correct',
      explanation: 'Sem bugs bloqueadores.',
      confidence: 0.7,
      findings: [
        {
          title: VALID_FINDING.title,
          body: VALID_FINDING.body,
          priority: 3, // omp usa número 0-3
          confidence: 0.5,
          file_path: 'src/net/buffer.c',
          line_start: 10,
          line_end: 12,
        },
      ],
    });
    expect(parsed.verdict).toBe('correct');
    expect(parsed.findings[0]).toMatchObject({
      priority: 'P3',
      file: 'src/net/buffer.c',
      lineStart: 10,
      lineEnd: 12,
    });
  });

  it('entrada sem JSON reconhecível → erro claro de "não encontrado"', () => {
    expect(() => parseReviewFindings('review ok, nada a reportar')).toThrow(
      ReviewFindingsParseError,
    );
    expect(() => parseReviewFindings('review ok, nada a reportar')).toThrow(
      /nenhum objeto ReviewFindings encontrado/,
    );
  });

  it('candidato malformado → erro claro com o defeito de schema', () => {
    const broken = { verdict: 'incorrect', confidence: 0.5, findings: [] };
    expect(() => parseReviewFindings(broken)).toThrow(
      ReviewFindingsParseError,
    );
    expect(() => parseReviewFindings(broken)).toThrow(/explanation/);
  });

  it('rejeita priority fora do enum P0-P3', () => {
    const withBadPriority = {
      ...VALID_PAYLOAD,
      findings: [{ ...VALID_FINDING, priority: 'P4' }],
    };
    expect(() => parseReviewFindings(withBadPriority)).toThrow(
      ReviewFindingsParseError,
    );
    expect(() => parseReviewFindings(withBadPriority)).toThrow(/priority/);

    const withNumericOutOfRange = {
      ...VALID_PAYLOAD,
      findings: [{ ...VALID_FINDING, priority: 4 }],
    };
    expect(() => parseReviewFindings(withNumericOutOfRange)).toThrow(
      /priority/,
    );
  });

  it('clampa confidence para o intervalo [0, 1]', () => {
    const parsed = parseReviewFindings({
      ...VALID_PAYLOAD,
      confidence: 1.7,
      findings: [{ ...VALID_FINDING, confidence: -0.25 }],
    });
    expect(parsed.confidence).toBe(1);
    expect(parsed.findings[0].confidence).toBe(0);
  });

  it('rejeita confidence não numérica', () => {
    expect(() =>
      parseReviewFindings({ ...VALID_PAYLOAD, confidence: 'alta' }),
    ).toThrow(/confidence/);
  });

  it('trunca title acima de 80 caracteres', () => {
    const parsed = parseReviewFindings({
      ...VALID_PAYLOAD,
      findings: [{ ...VALID_FINDING, title: 'x'.repeat(200) }],
    });
    expect(parsed.findings[0].title).toHaveLength(80);
  });

  it('rejeita intervalo de linhas invertido', () => {
    expect(() =>
      parseReviewFindings({
        ...VALID_PAYLOAD,
        findings: [{ ...VALID_FINDING, lineStart: 44, lineEnd: 42 }],
      }),
    ).toThrow(/lineEnd/);
  });

  it('findings ausentes viram lista vazia (tolerância)', () => {
    const parsed = parseReviewFindings({
      verdict: 'correct',
      explanation: 'Mudança limpa.',
      confidence: 0.95,
    });
    expect(parsed.findings).toEqual([]);
  });
});
