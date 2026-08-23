import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanizeToastDetail, useToastStore } from './toast-store';

function clearToasts(): void {
  for (const toast of useToastStore.getState().toasts) {
    useToastStore.getState().dismiss(toast.id);
  }
}

describe('toast store UX policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('turns Electron transport errors into a short recovery instruction', () => {
    expect(
      humanizeToastDetail(
        "Error invoking remote method 'orch:mission.start': Error: " +
          'guided_plan_preflight_blocked: guided_plan_unborn_with_files: ' +
          'faça o primeiro commit dos arquivos existentes e tente iniciar a missão novamente',
      ),
    ).toBe(
      'Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.',
    );
  });

  it('never exposes PREVC or pane bootstrap codes in the recovery surface', () => {
    expect(
      humanizeToastDetail(
        'A missão não foi autorizada: Error invoking remote method ' +
          "'orch:mission.start': Error: " +
          'guided_plan_legacy_receipt_blocked: receipt antigo',
      ),
    ).toBe(
      'O plano aprovado ficou desatualizado. Revise a equipe e aprove a missão novamente.',
    );
    expect(
      humanizeToastDetail(
        'agent pane did not start after prompt delivery',
      ),
    ).toBe(
      'O agente não ficou pronto a tempo. O Nexus encerrou a execução com segurança; tente novamente.',
    );
    expect(
      humanizeToastDetail(
        'A missão não foi autorizada: Error invoking remote method ' +
          "'orch:mission.start': Error: " +
          'guided_plan_preflight_blocked: project runtime contains an invalid worktree state',
      ),
    ).toBe(
      'O estado local de uma execução anterior ficou inconsistente. Nenhum agente foi iniciado; encerre a missão travada antes de tentar novamente.',
    );
  });

  it('EXATAMENTE no título de sucesso não vira a frase de falha', () => {
    const ready =
      'SaaS lista de espera com EXATAMENTE — o resultado final está pronto.';
    // 065 live: /\bE[A-Z]{3,}\b/ treated EXATAMENTE as errno before authored PT.
    expect(humanizeToastDetail('SaaS lista de espera com EXATAMENTE')).toMatch(
      /^Não foi possível concluir esta etapa/,
    );
    const push = useToastStore.getState().push;
    push('success', 'Missão pronta', {
      detail: ready,
      action: { label: 'Ver resultado', onClick: vi.fn() },
    });
    expect(useToastStore.getState().toasts).toMatchObject([
      {
        kind: 'success',
        title: 'Missão pronta',
        detail: ready,
        action: { label: 'Ver resultado' },
      },
    ]);
    expect(useToastStore.getState().toasts[0]?.detail).not.toMatch(
      /Não foi possível concluir esta etapa/,
    );
  });

  it('keeps success copy when a done mission title looks like a diagnostic', () => {
    const push = useToastStore.getState().push;
    push(
      'success',
      'Missão pronta',
      'Fix the API server — o resultado final está pronto.',
    );

    expect(useToastStore.getState().toasts).toMatchObject([
      {
        kind: 'success',
        title: 'Missão pronta',
        detail: 'Fix the API server — o resultado final está pronto.',
      },
    ]);
    expect(useToastStore.getState().toasts[0]?.detail).not.toMatch(
      /Não foi possível concluir esta etapa/,
    );
  });

  it('does not reuse a previous error detail on Missão pronta', () => {
    const push = useToastStore.getState().push;
    const ready = 'Fix the API server — o resultado final está pronto.';
    // 065 shot: title had English residue ("server"). Humanizing that
    // title as a failure produced DEFAULT_UNKNOWN_ERROR on a success card.
    expect(humanizeToastDetail('Fix the API server')).toMatch(
      /^Não foi possível concluir esta etapa/,
    );

    push('error', 'Falha técnica na missão', {
      detail:
        'Não foi possível concluir esta etapa. Tente novamente. Se continuar, abra a missão e veja a aba Atividade.',
    });
    push('success', 'Missão pronta', {
      detail: ready,
      action: { label: 'Ver resultado', onClick: vi.fn() },
      dedupeKey: 'mission-completed:mission-f7eb1133',
    });

    const toasts = useToastStore.getState().toasts;
    const success = toasts.find((item) => item.title === 'Missão pronta');
    expect(success).toMatchObject({
      kind: 'success',
      title: 'Missão pronta',
      detail: ready,
      action: { label: 'Ver resultado' },
    });
    expect(success?.detail).not.toMatch(/Não foi possível concluir esta etapa/);
    expect(toasts.some((item) => item.kind === 'error')).toBe(true);
  });

  it('still humanizes only real failure toasts', () => {
    const push = useToastStore.getState().push;
    push(
      'error',
      'Não deu pra iniciar a execução',
      "Error invoking remote method 'orch:mission.start': Error: " +
        'provider temporarily unavailable',
    );
    expect(useToastStore.getState().toasts[0]?.detail).toMatch(
      /^Não foi possível concluir esta etapa/,
    );
  });

  it('strips presentation and Electron wrappers from unknown launch errors', () => {
    expect(
      humanizeToastDetail(
        'A missão não foi autorizada: Error invoking remote method ' +
          "'orch:mission.start': Error: provider temporarily unavailable",
      ),
    ).toMatch(
      /^Não foi possível concluir esta etapa\. Tente novamente\. Se continuar, abra a missão e veja a aba Atividade\. Detalhe técnico: /,
    );
  });

  it('collapses launch, rejection and mirrored mission-blocked into one concrete alert', () => {
    const push = useToastStore.getState().push;
    push('success', 'Frota em campo', 'Missão de teste');
    push(
      'error',
      'Não deu pra iniciar a execução',
      "Error invoking remote method 'orch:mission.start': Error: " +
        'guided_plan_preflight_blocked: guided_plan_unborn_with_files',
    );
    push(
      'warn',
      'Missão precisa de você',
      'Missão de teste, travada aguardando decisão.',
    );

    expect(useToastStore.getState().toasts).toMatchObject([
      {
        kind: 'error',
        title: 'Não deu pra iniciar a execução',
        detail:
          'Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.',
        dedupeKey: 'mission-execution',
      },
    ]);
  });

  it('keeps the transient stack bounded to the three latest signals', () => {
    const push = useToastStore.getState().push;
    push('info', 'Primeiro');
    push('info', 'Segundo');
    push('warn', 'Terceiro');
    push('error', 'Quarto');

    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Segundo',
      'Terceiro',
      'Quarto',
    ]);
  });

  it('does not evict actionable alerts to make room for a transient signal', () => {
    const push = useToastStore.getState().push;
    const action = { label: 'Abrir missão', onClick: vi.fn() };
    push('warn', 'Ação 1', { action });
    push('warn', 'Ação 2', { action });
    push('warn', 'Ação 3', { action });
    push('info', 'Sinal transitório');

    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Ação 1',
      'Ação 2',
      'Ação 3',
    ]);
  });

  it('keeps the hard limit when every visible alert has an action', () => {
    const push = useToastStore.getState().push;
    const action = { label: 'Abrir missão', onClick: vi.fn() };
    push('warn', 'Ação 1', { action });
    push('warn', 'Ação 2', { action });
    push('warn', 'Ação 3', { action });
    push('warn', 'Ação 4', { action });

    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Ação 2',
      'Ação 3',
      'Ação 4',
    ]);
  });
});
