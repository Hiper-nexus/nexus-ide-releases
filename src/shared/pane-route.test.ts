import { describe, expect, test } from 'vitest';
import {
  PANE_ROUTE_REQUEST_MAX,
  isPaneRouteEffort,
  paneRouteEffortLabel,
  paneRouteRequestSchema,
  paneRouteSummary,
  type PaneRouteProposal,
} from './pane-route';

const proposal = (over: Partial<PaneRouteProposal> = {}): PaneRouteProposal => ({
  tier: 'medium',
  reason: 'tier medium',
  source: 'jev',
  ...over,
});

describe('paneRouteRequestSchema', () => {
  test('aceita o pedido do operador sem CLI escolhida', () => {
    const parsed = paneRouteRequestSchema.safeParse({ request: 'arruma o login' });
    expect(parsed.success).toBe(true);
  });

  test('aceita a CLI que o operador escolheu na mão', () => {
    const parsed = paneRouteRequestSchema.safeParse({ request: 'x', adapterId: 'codex' });
    expect(parsed.success && parsed.data.adapterId).toBe('codex');
  });

  test('recusa chave desconhecida — o renderer não injeta autoridade', () => {
    const parsed = paneRouteRequestSchema.safeParse({
      request: 'x',
      missionId: 'm1',
    });
    expect(parsed.success).toBe(false);
  });

  test('recusa pedido vazio e pedido acima do teto', () => {
    expect(paneRouteRequestSchema.safeParse({ request: '' }).success).toBe(false);
    expect(
      paneRouteRequestSchema.safeParse({ request: 'a'.repeat(PANE_ROUTE_REQUEST_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('isPaneRouteEffort', () => {
  test('usa o vocabulário do roteador, não um segundo inventado', () => {
    expect(isPaneRouteEffort('high')).toBe(true);
    expect(isPaneRouteEffort('xhigh')).toBe(true);
    // `none` e `max` NÃO existem em ROUTE_EFFORTS: "a CLI decide" é ausência.
    expect(isPaneRouteEffort('none')).toBe(false);
    expect(isPaneRouteEffort('max')).toBe(false);
    expect(isPaneRouteEffort(undefined)).toBe(false);
  });
});

describe('paneRouteEffortLabel', () => {
  test('esforço ausente lê como "a CLI decide", nunca como desligado', () => {
    expect(paneRouteEffortLabel(undefined)).toBe('A CLI decide');
  });

  test('cada nível tem rótulo próprio', () => {
    expect(paneRouteEffortLabel('low')).toBe('Baixo');
    expect(paneRouteEffortLabel('xhigh')).toBe('Máximo');
  });
});

describe('paneRouteSummary', () => {
  test('diz quem decidiu — a escolha não pode parecer sorteio', () => {
    expect(paneRouteSummary(proposal({ source: 'jev' }))).toContain('decidido pelo Jev');
    expect(paneRouteSummary(proposal({ source: 'heuristic' }))).toContain('pela regra');
    expect(paneRouteSummary(proposal({ source: 'mixed' }))).toContain('Jev + regra');
    expect(paneRouteSummary(proposal({ source: 'operator' }))).toContain('escolha sua');
  });

  test('inclui a especialidade quando o motor classificou uma', () => {
    expect(paneRouteSummary(proposal({ specialty: 'security' }))).toContain('security');
    expect(paneRouteSummary(proposal())).toBe('medium — decidido pelo Jev');
  });
});
