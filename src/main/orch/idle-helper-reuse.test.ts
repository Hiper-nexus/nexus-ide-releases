import { describe, expect, it, vi } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  HELPER_REUSE_MAX_CANDIDATES,
  HELPER_REUSE_MIN_IDLE_MS,
  judgeIdleHelperReuse,
  listIdleHelperCandidates,
  taskAsksForIndependentReview,
} from './idle-helper-reuse';

const scope = testProjectScope();
const NOW = 1_700_000_000_000;

function pane(over: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    paneId: 'pane-1',
    sessionId: 'sess-1',
    title: 'Auxiliar',
    kind: 'cli-agent',
    adapterId: 'codex',
    state: 'idle',
    ...over,
  } as PaneSnapshot;
}

const idleSemantic = (sessionId: string, updatedAt = NOW - 60_000) =>
  ({
    status: 'idle',
    sessionId,
    paneId: 'pane',
    updatedAt,
  }) as never;

function deps(over: Record<string, unknown> = {}) {
  return {
    listPaneSnapshots: () => [] as PaneSnapshot[],
    getAuthority: () => null,
    getSemanticStatus: (sid: string) => idleSemantic(sid),
    stdinWritable: () => true,
    armedAutoClose: () => null,
    isIsolatedWriter: () => false,
    now: () => NOW,
    ...over,
  } as never;
}

const operatorHand = (over: Record<string, unknown> = {}) => ({
  mode: 'operator-hand' as const,
  callerSessionId: 'sess-op',
  adapterId: 'codex',
  readOnly: false,
  newTask: 'continuar o parser',
  scope,
  ...over,
});

describe('listIdleHelperCandidates', () => {
  it('mão do operador: filho vivo e parado entra; filho de outro pai não', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand(),
      deps({
        listPaneSnapshots: () => [pane(), pane({ paneId: 'p2', sessionId: 'sess-2' })],
        getAuthority: (sid: string) =>
          sid === 'sess-1'
            ? ({ operatorParentSessionId: 'sess-op' } as never)
            : ({ operatorParentSessionId: 'sess-outro' } as never),
      }),
    );
    expect(candidates.map((c) => c.paneId)).toEqual(['pane-1']);
  });

  it('missão da aba: worker da missão entra; orquestrador e pane de outra missão não', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand({ mode: 'tab-mission', missionId: 'm-1' }),
      deps({
        listPaneSnapshots: () => [
          pane({ missionId: 'm-1', role: 'worker' }),
          pane({ paneId: 'p2', sessionId: 's2', missionId: 'm-1', role: 'orchestrator' }),
          pane({ paneId: 'p3', sessionId: 's3', missionId: 'm-2', role: 'worker' }),
        ],
      }),
    );
    expect(candidates.map((c) => c.paneId)).toEqual(['pane-1']);
  });

  it('exclui busy, exited, outra CLI, readOnly diferente, shell e o próprio chamador', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand(),
      deps({
        listPaneSnapshots: () => [
          pane({ state: 'busy' }),
          pane({ paneId: 'p2', sessionId: 's2', state: 'exited' }),
          pane({ paneId: 'p3', sessionId: 's3', adapterId: 'claude' }),
          pane({ paneId: 'p4', sessionId: 's4', readOnly: true }),
          pane({ paneId: 'p5', sessionId: 's5', kind: 'shell' }),
          pane({ paneId: 'p6', sessionId: 'sess-op' }),
        ],
        getAuthority: () => ({ operatorParentSessionId: 'sess-op' }) as never,
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('exige ≥20s ocioso e exclui pane sem marca semântica ou em diálogo', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand(),
      deps({
        listPaneSnapshots: () => [
          pane({ sessionId: 's-ok' }),
          pane({ paneId: 'p2', sessionId: 's-novo' }),
          pane({ paneId: 'p3', sessionId: 's-sem' }),
          pane({ paneId: 'p4', sessionId: 's-dialogo' }),
        ],
        getAuthority: () => ({ operatorParentSessionId: 'sess-op' }) as never,
        getSemanticStatus: (sid: string) =>
          sid === 's-ok'
            ? idleSemantic(sid)
            : sid === 's-novo'
              ? idleSemantic(sid, NOW - HELPER_REUSE_MIN_IDLE_MS + 1)
              : sid === 's-sem'
                ? null
                : ({ status: 'awaiting-input', sessionId: sid, paneId: 'x', updatedAt: NOW - 99_000 } as never),
      }),
    );
    expect(candidates.map((c) => c.sessionId)).toEqual(['s-ok']);
  });

  it('exclui pane fechando, com autoClose armado e writer isolado', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand(),
      deps({
        listPaneSnapshots: () => [
          pane(),
          pane({ paneId: 'p2', sessionId: 's2' }),
          pane({ paneId: 'p3', sessionId: 's3' }),
        ],
        getAuthority: () => ({ operatorParentSessionId: 'sess-op' }) as never,
        stdinWritable: (sid: string) => sid !== 'sess-1',
        armedAutoClose: (sid: string) => (sid === 's2' ? 'p2' : null),
        isIsolatedWriter: (_s: unknown, sid: string) => sid === 's3',
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('tarefa de revisão exclui writer; candidato readOnly ainda entra', () => {
    const candidates = listIdleHelperCandidates(
      operatorHand({ newTask: 'revise o diff do parser', readOnly: true }),
      deps({
        listPaneSnapshots: () => [pane({ readOnly: false }), pane({ paneId: 'p2', sessionId: 's2', readOnly: true })],
        getAuthority: () => ({ operatorParentSessionId: 'sess-op' }) as never,
      }),
    );
    expect(candidates.map((c) => c.paneId)).toEqual(['p2']);
  });

  it('ordena do mais recentemente ocioso e limita a 5', () => {
    const panes = Array.from({ length: 7 }, (_, i) =>
      pane({ paneId: `p${i}`, sessionId: `s${i}` }),
    );
    const candidates = listIdleHelperCandidates(
      operatorHand(),
      deps({
        listPaneSnapshots: () => panes,
        getAuthority: () => ({ operatorParentSessionId: 'sess-op' }) as never,
        getSemanticStatus: (sid: string) =>
          idleSemantic(sid, NOW - 30_000 - Number(sid.slice(1)) * 10_000),
      }),
    );
    expect(candidates).toHaveLength(HELPER_REUSE_MAX_CANDIDATES);
    expect(candidates.map((c) => c.sessionId)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });
});

describe('taskAsksForIndependentReview', () => {
  it('casa revisão/review/audit e ignora prosa comum', () => {
    expect(taskAsksForIndependentReview('revise a entrega')).toBe(true);
    expect(taskAsksForIndependentReview('faça o review do diff')).toBe(true);
    expect(taskAsksForIndependentReview('audit the auth flow')).toBe(true);
    expect(taskAsksForIndependentReview('implemente o login')).toBe(false);
  });
});

describe('judgeIdleHelperReuse', () => {
  const candidates = [
    { paneId: 'pane-1', sessionId: 'sess-1', title: 'Auxiliar', idleForMs: 60_000 },
    { paneId: 'pane-2', sessionId: 'sess-2', title: 'Revisor', idleForMs: 45_000 },
  ];

  function judgeDeps(answer: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
    const judgeFn = vi.fn(async (_input: unknown) => answer as never);
    return {
      judgeFn,
      deps: {
        judge: judgeFn,
        surfaceEnabled: () => true,
        hasKey: () => true,
        lastHandoffSummary: () => 'Refatorei o parser de args.',
        ...extra,
      } as never,
    };
  }

  it('sem superfície ou sem chave nem chama o Jev', async () => {
    const { judgeFn, deps: d } = judgeDeps(null, { surfaceEnabled: () => false });
    expect(
      await judgeIdleHelperReuse(
        { newTask: 'x', candidates, scope, missionId: null },
        d,
      ),
    ).toBeNull();
    expect(judgeFn).not.toHaveBeenCalled();
    const { judgeFn: j2, deps: d2 } = judgeDeps(null, { hasKey: () => false });
    expect(
      await judgeIdleHelperReuse(
        { newTask: 'x', candidates, scope, missionId: null },
        d2,
      ),
    ).toBeNull();
    expect(j2).not.toHaveBeenCalled();
  });

  it('hN com confiança ≥0.7 escolhe o candidato e registra a decisão', async () => {
    const { judgeFn, deps: d } = judgeDeps({
      model: 'jev-m',
      answers: { pick: { type: 'choice', choice: 'h2', probabilities: {}, confidence: 0.8 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const choice = await judgeIdleHelperReuse(
      { newTask: 'continue o parser', candidates, scope, missionId: 'm-1', callerSessionId: 'sess-op' },
      d,
    );
    expect(choice?.candidate.paneId).toBe('pane-2');
    expect(choice?.confidence).toBe(0.8);
    expect(choice?.reason).toBe('helper ocioso com contexto relacionado (Jev 0.8)');
    const state = (
      judgeFn.mock.calls[0]![0] as unknown as {
        state: {
          newTask: string;
          helpers: { id: string; title: string; recentWork: string }[];
        };
      }
    ).state;
    expect(state.helpers.map((helper) => helper.id)).toEqual(['h1', 'h2']);
    expect(state.helpers[0]!.recentWork).toBe('Refatorei o parser de args.');
  });

  it('none, confiança baixa, escolha inválida e judge null → null', async () => {
    for (const answers of [
      { pick: { type: 'choice', choice: 'none', probabilities: {}, confidence: 0.99 } },
      { pick: { type: 'choice', choice: 'h1', probabilities: {}, confidence: 0.5 } },
      { pick: { type: 'choice', choice: 'h9', probabilities: {}, confidence: 0.99 } },
    ]) {
      const { deps: d } = judgeDeps({ model: 'm', answers, usage: { input_tokens: 1, output_tokens: 1 } });
      expect(
        await judgeIdleHelperReuse({ newTask: 'x', candidates, scope, missionId: null }, d),
      ).toBeNull();
    }
    const { deps: dNull } = judgeDeps(null);
    expect(
      await judgeIdleHelperReuse({ newTask: 'x', candidates, scope, missionId: null }, dNull),
    ).toBeNull();
  });

  it('sem handoff usa o tail ANSI-stripado do output (≤600 chars)', async () => {
    const { judgeFn, deps: d } = judgeDeps(null, {
      lastHandoffSummary: () => null,
      outputTail: () => '[31merro[0m '.repeat(100),
    });
    await judgeIdleHelperReuse({ newTask: 'x', candidates, scope, missionId: null }, d);
    const state = (
      judgeFn.mock.calls[0]![0] as unknown as {
        state: { helpers: { recentWork: string }[] };
      }
    ).state;
    expect(state.helpers[0]!.recentWork.length).toBeLessThanOrEqual(600);
    expect(state.helpers[0]!.recentWork).not.toContain('[');
  });
});
