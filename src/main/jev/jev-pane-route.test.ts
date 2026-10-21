import { describe, expect, test, vi } from 'vitest';
import { proposePaneRoute } from './jev-pane-route';

type Classify = NonNullable<Parameters<typeof proposePaneRoute>[1]>['classify'];

const classified = (over: Record<string, unknown> = {}): ReturnType<NonNullable<Classify>> =>
  Promise.resolve({
    kind: 'classified',
    classification: {
      tier: 'hard',
      tierConfidence: 0.91,
      specialty: 'security',
      specialtyConfidence: 0.88,
      effort: 'high',
      effortConfidence: 0.84,
      escalate: 0.2,
      model: 'jev-1.13.0',
      ...(over.classification as object ?? {}),
    },
    skillSuggestion: null,
    batch: { requestCount: 1, questionCount: 5 },
    ...over,
  } as Awaited<ReturnType<NonNullable<Classify>>>);

const deps = (classify: Classify) => ({ classify, projectRoot: () => undefined });

describe('proposePaneRoute', () => {
  test('preenche o esforço que o pane aberto na mão nunca teve', async () => {
    const result = await proposePaneRoute({ request: 'auditar o login' }, deps(() => classified()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.effort).toBe('high');
    expect(result.proposal.tier).toBe('hard');
    expect(result.proposal.specialty).toBe('security');
  });

  test('diz que foi o Jev que decidiu — a escolha não pode parecer sorteio', async () => {
    const result = await proposePaneRoute({ request: 'auditar' }, deps(() => classified()));
    expect(result.ok && result.proposal.source).toBe('jev');
    expect(result.ok && result.proposal.confidence?.tier).toBe(0.91);
  });

  test('skill abaixo de 0,7 de confiança não entra sozinha', async () => {
    const low = await proposePaneRoute(
      { request: 'x' },
      deps(() => classified({ skillSuggestion: { name: 'oc-scout', pkg: 'oc', confidence: 0.55 } })),
    );
    expect(low.ok && low.proposal.skill).toBeUndefined();

    const high = await proposePaneRoute(
      { request: 'x' },
      deps(() => classified({ skillSuggestion: { name: 'oc-scout', pkg: 'oc', confidence: 0.82 } })),
    );
    expect(high.ok && high.proposal.skill).toBe('oc-scout');
  });

  test('pedido vazio não consulta o Jev', async () => {
    const classify = vi.fn(() => classified());
    const result = await proposePaneRoute({ request: '   ' }, deps(classify as unknown as Classify));
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(classify).not.toHaveBeenCalled();
  });

  test('superfície desligada devolve recusa limpa, nunca exceção', async () => {
    const result = await proposePaneRoute(
      { request: 'x' },
      deps(() => Promise.resolve({ kind: 'unavailable', reason: 'disabled' } as never)),
    );
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  test('Jev fora do ar é fail-open: recusa, e o + Pane segue como sempre', async () => {
    const result = await proposePaneRoute(
      { request: 'x' },
      deps(() => Promise.reject(new Error('rede'))),
    );
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  test('a proposta nunca ecoa o pedido do operador', async () => {
    const segredo = 'token sk-abc123 e a senha do banco';
    const result = await proposePaneRoute({ request: segredo }, deps(() => classified()));
    expect(JSON.stringify(result)).not.toContain('sk-abc123');
    expect(JSON.stringify(result)).not.toContain('senha');
  });
});
