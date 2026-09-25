import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeJevRouteFallback, resetJevRouteNoticesForTests } from './jev-route-notice';

describe('noticeJevRouteFallback', () => {
  beforeEach(() => resetJevRouteNoticesForTests());

  it('um toast por motivo por execução; rota com Jev não avisa', () => {
    const push = vi.fn();
    expect(noticeJevRouteFallback({ source: 'jev' }, push)).toBe(false);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'timeout' }, push)).toBe(true);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'timeout' }, push)).toBe(false);
    expect(noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'no-key' }, push)).toBe(true);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0]).toEqual([
      'warn',
      'Jev não respondeu (tempo esgotado)',
      expect.objectContaining({ detail: 'O pane foi aberto pela heurística.' }),
    ]);
  });

  it('sem chave ou desligado aponta para Chaves de API', () => {
    const push = vi.fn();
    noticeJevRouteFallback({ source: 'heuristic', jevUnavailable: 'no-key' }, push);
    expect(push.mock.calls[0]![2].detail).toContain('Configurações › Chaves de API');
  });
});
