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
});

describe('enqueueBalloon / dismissBalloon', () => {
  it('mostra direto quando não há balão atual', () => {
    const s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done'));
    expect(s.current?.text).toContain('Deploy');
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
});
