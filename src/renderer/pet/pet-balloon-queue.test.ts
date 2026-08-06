import { describe, expect, it } from 'vitest';
import {
  BALLOON_QUEUE_LIMIT,
  EMPTY_BALLOON_QUEUE,
  balloonTextFor,
  dismissBalloon,
  enqueueBalloon,
} from './pet-balloon-queue';
import type { PetEvent } from '../../shared/pet-types';

const ev = (kind: PetEvent['kind'], title = 'Deploy'): PetEvent => ({
  kind,
  title,
  at: 1,
});

describe('balloonTextFor', () => {
  it('nomeia a missão no balão', () => {
    expect(balloonTextFor(ev('mission-done'))).toContain('Deploy');
    expect(balloonTextFor(ev('mission-failed'))).toContain('Deploy');
  });

  it('agent-idle não gera balão', () => {
    expect(balloonTextFor(ev('agent-idle'))).toBeNull();
  });

  it('mission-blocked pede intervenção com o nome da missão completo', () => {
    const text = balloonTextFor(
      ev('mission-blocked', 'Execução + QA'),
    );
    expect(text).toContain('Preciso de você');
    expect(text).toContain('Execução + QA');
    // Sem causa no evento o balão ADMITE que não sabe; o texto antigo
    // ("a missão parou esperando uma decisão") prometia uma decisão que
    // ninguém sabia qual era, e deixava o operador sem ação.
    expect(text).toContain('Motivo não registrado');
    expect(text).toContain('Abra o diagnóstico');
    expect(text).not.toContain('esperando uma decisão');
    // Não pode sair truncado no conteúdo (ellipsis era só CSS; string é integral).
    expect(text).not.toContain('…');
  });

  it('mission-blocked mostra a causa e o que fazer quando ela é conhecida', () => {
    const text = balloonTextFor({
      kind: 'mission-blocked',
      title: 'Execução + QA',
      at: 1,
      cause: {
        code: 'orphan-plan',
        headline: 'O plano selado ficou numa versão anterior da intenção.',
        action: 'Retome a missão para re-selar o plano na versão atual.',
      },
    });

    expect(text).toBe(
      'Preciso de você: Execução + QA — O plano selado ficou numa versão ' +
        'anterior da intenção. Retome a missão para re-selar o plano na ' +
        'versão atual.',
    );
  });

  it('causa longa é cortada no PORQUÊ, nunca no acionável', () => {
    const action = 'Retome a missão para re-selar o plano na versão atual.';
    const text = balloonTextFor({
      kind: 'mission-blocked',
      title: 'M',
      at: 1,
      cause: {
        code: 'dispatch-failed',
        headline: `${'motivo muito comprido '.repeat(20)}fim.`,
        action,
      },
    })!;

    expect(text).toContain('…');
    expect(text.endsWith(action)).toBe(true);
  });

  it('falha técnica esgotada oferece diagnóstico sem simular decisão humana', () => {
    const text = balloonTextFor(
      ev('mission-technical-failure', 'Execução + QA'),
    );
    expect(text).toContain('Falha técnica');
    expect(text).toContain('Execução + QA');
    expect(text).toContain('diagnóstico');
    expect(text).not.toContain('Preciso de você');
    expect(text).not.toContain('decisão');
  });

  it('agent-waiting inclui o contexto do agente quando há título', () => {
    const text = balloonTextFor(ev('agent-waiting', 'Claude worker'));
    expect(text).toContain('Claude worker');
    expect(text).toContain('pendente');
  });
});

describe('enqueueBalloon / dismissBalloon', () => {
  it('mostra direto quando não há balão atual', () => {
    const s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done'));
    expect(s.current?.text).toContain('Deploy');
    expect(s.current?.action).toBe('open-ops');
    // O destino tem UM nome em toda a interface: "Painel de operações".
    // Antes convivia como "Ops Board" (título), "Painel" (barra) e
    // "Painel de operações" (⌘K) — três nomes para a mesma superfície.
    expect(s.current?.cta).toContain('painel');
    expect(s.queued).toEqual([]);
  });

  it('enfileira quando já há um visível e promove no dismiss', () => {
    let s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done', 'A'));
    s = enqueueBalloon(s, ev('mission-failed', 'B'));
    expect(s.current?.text).toContain('A');
    expect(s.queued).toHaveLength(1);
    s = dismissBalloon(s);
    expect(s.current?.text).toContain('B');
    s = dismissBalloon(s);
    expect(s.current).toBeNull();
  });

  it('urgente sobe na frente de celebração', () => {
    let s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done', 'Done'));
    s = enqueueBalloon(s, ev('mission-blocked', 'NeedYou'));
    expect(s.current?.kind).toBe('mission-blocked');
    expect(s.current?.urgent).toBe(true);
    expect(s.queued[0]?.kind).toBe('mission-done');
  });

  it('falha técnica esgotada é urgente e abre o diagnóstico no Ops', () => {
    const s = enqueueBalloon(
      EMPTY_BALLOON_QUEUE,
      ev('mission-technical-failure', 'Deploy'),
    );
    expect(s.current?.urgent).toBe(true);
    expect(s.current?.action).toBe('open-ops');
    expect(s.current?.cta).toBe('Ver diagnóstico');
  });

  it('fila estoura descartando os mais antigos', () => {
    let s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done', 'vis'));
    for (let i = 0; i < BALLOON_QUEUE_LIMIT + 2; i += 1) {
      s = enqueueBalloon(s, ev('mission-done', `m${i}`));
    }
    expect(s.queued).toHaveLength(BALLOON_QUEUE_LIMIT);
    expect(s.queued[0].text).toContain('m2');
  });

  it('agent-idle não muda o estado', () => {
    const s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('agent-idle'));
    expect(s).toBe(EMPTY_BALLOON_QUEUE);
  });

  it('ids são únicos e crescentes', () => {
    let s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done', 'A'));
    s = enqueueBalloon(s, ev('mission-done', 'B'));
    const ids = [s.current!.id, ...s.queued.map((b) => b.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mantém o aviso atual até uma dispensa explícita', () => {
    let s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done', 'A'));
    s = enqueueBalloon(s, ev('mission-failed', 'B'));

    // A fila não tem relógio: apenas uma ação explícita promove o próximo.
    expect(s.current?.text).toContain('A');
    expect(s.queued).toHaveLength(1);
    s = dismissBalloon(s);
    expect(s.current?.text).toContain('B');
  });
});
