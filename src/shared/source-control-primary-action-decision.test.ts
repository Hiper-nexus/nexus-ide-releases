import { describe, expect, it } from 'vitest';
import { resolveSourceControlPrimaryActionDecision } from './source-control-primary-action-decision';
import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision';

function inputs(
  overrides: Partial<SourceControlPrimaryActionDecisionInputs> = {},
): SourceControlPrimaryActionDecisionInputs {
  return {
    stagedCount: 0,
    hasStageableChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteBusy: false,
    hasCurrentBranch: true,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    isDefaultBranch: false,
    prState: null,
    autoMergeEnabled: false,
    autoMergeAllowed: true,
    mergeQueueRequired: false,
    ...overrides,
  };
}

describe('resolveSourceControlPrimaryActionDecision', () => {
  it('commita quando há staged e mensagem', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ stagedCount: 2, hasMessage: true }),
      ),
    ).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Gravar as mudanças no histórico',
      disabled: false,
    });
  });

  it('desliga o commit sem mensagem', () => {
    const d = resolveSourceControlPrimaryActionDecision(
      inputs({ stagedCount: 1, hasMessage: false }),
    );
    expect(d.kind).toBe('commit');
    expect(d.disabled).toBe(true);
    expect(d.title).toMatch(/mensagem/i);
  });

  it('oferece Adicionar tudo quando há mudanças stageable', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ hasStageableChanges: true }),
      ),
    ).toMatchObject({
      kind: 'stage',
      label: 'Adicionar tudo',
      disabled: false,
    });
  });

  it('publica quando não há upstream', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ hasUpstream: false }),
      ),
    ).toMatchObject({
      kind: 'publish',
      label: 'Publicar',
      disabled: false,
    });
  });

  it('envia quando há commits ahead', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(inputs({ ahead: 3 })),
    ).toMatchObject({
      kind: 'push',
      label: 'Enviar',
      title: 'Enviar 3 commits para o remoto',
      disabled: false,
    });
  });

  it('abre PR quando a branch está no remoto sem PR', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(inputs()),
    ).toMatchObject({
      kind: 'create_pr',
      label: 'Abrir PR',
      disabled: false,
    });
  });

  it('não reabre PR já mergeado nesta branch', () => {
    const d = resolveSourceControlPrimaryActionDecision(
      inputs({ prState: 'merged' }),
    );
    expect(d).toMatchObject({
      kind: 'create_pr',
      disabled: true,
    });
    expect(d.title).toMatch(/mergeado/i);
  });

  it('oferece um PR novo quando o anterior foi fechado', () => {
    const d = resolveSourceControlPrimaryActionDecision(
      inputs({ prState: 'closed' }),
    );
    expect(d).toMatchObject({
      kind: 'create_pr',
      label: 'Abrir PR',
      disabled: false,
    });
    expect(d.title).toMatch(/fechado/i);
  });

  it('não abre PR na branch padrão limpa', () => {
    const d = resolveSourceControlPrimaryActionDecision(
      inputs({ isDefaultBranch: true }),
    );
    expect(d.disabled).toBe(true);
    expect(d.kind).toBe('commit');
  });

  it('enfileira quando a merge queue está disponível', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({
          prState: 'open',
          mergeQueueRequired: true,
          autoMergeEnabled: false,
        }),
      ),
    ).toMatchObject({
      kind: 'enqueue',
      label: 'Enfileirar',
      disabled: false,
    });
  });

  it('enfileira via auto-merge quando o PR ainda não pode mergear', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({
          prState: 'open',
          mergeQueueRequired: false,
          autoMergeAllowed: true,
          reviewDecision: 'REVIEW_REQUIRED',
        }),
      ),
    ).toMatchObject({ kind: 'enqueue', disabled: false });
  });

  it('não oferece enqueue de novo quando o auto-merge já está ligado', () => {
    const d = resolveSourceControlPrimaryActionDecision(
      inputs({
        prState: 'open',
        autoMergeEnabled: true,
        mergeQueueRequired: true,
      }),
    );
    expect(d.kind).toBe('enqueue');
    expect(d.disabled).toBe(true);
    expect(d.title).toMatch(/já está ligado/i);
  });

  it('desliga com title claro em conflitos, commit e remoto ocupado', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ hasUnresolvedConflicts: true, stagedCount: 1, hasMessage: true }),
      ),
    ).toMatchObject({ disabled: true, title: expect.stringMatching(/conflitos/i) });

    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ isCommitting: true, stagedCount: 1, hasMessage: true }),
      ),
    ).toMatchObject({ disabled: true, title: expect.stringMatching(/andamento/i) });

    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ isRemoteBusy: true, ahead: 1 }),
      ),
    ).toMatchObject({ disabled: true, kind: 'push' });
  });

  it('oferece pull habilitado — divergência e behind puxam do remoto (F-584)', () => {
    expect(
      resolveSourceControlPrimaryActionDecision(
        inputs({ ahead: 1, behind: 2 }),
      ),
    ).toMatchObject({
      kind: 'pull',
      disabled: false,
      title: expect.stringMatching(/divergiu/i),
    });

    expect(
      resolveSourceControlPrimaryActionDecision(inputs({ behind: 2 })),
    ).toMatchObject({
      kind: 'pull',
      disabled: false,
      title: 'Puxar 2 commits do remoto',
    });
  });
});
