import { describe, expect, it } from 'vitest';
import {
  BALLOON_QUEUE_LIMIT,
  BALLOON_DONE_DURATION_MS,
  BALLOON_URGENT_DURATION_MS,
  EMPTY_BALLOON_QUEUE,
  balloonDurationFor,
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

  it('mission-blocked pede intervenção com o nome da missão', () => {
    const text = balloonTextFor(ev('mission-blocked'));
    expect(text).toContain('Preciso de você');
    expect(text).toContain('Deploy');
  });
});

describe('enqueueBalloon / dismissBalloon', () => {
  it('mostra direto quando não há balão atual', () => {
    const s = enqueueBalloon(EMPTY_BALLOON_QUEUE, ev('mission-done'));
    expect(s.current?.text).toContain('Deploy');
    expect(s.current?.action).toBe('open-ops');
    expect(s.current?.cta).toContain('Ops');
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
    expect(s.current?.durationMs).toBe(BALLOON_URGENT_DURATION_MS);
    expect(s.queued[0]?.kind).toBe('mission-done');
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

  it('balloonDurationFor is longer for intervention', () => {
    expect(balloonDurationFor('mission-blocked')).toBeGreaterThan(
      balloonDurationFor('mission-done'),
    );
  });

  it('mantém a conclusão visível por tempo suficiente para ser percebida', () => {
    expect(balloonDurationFor('mission-done')).toBe(BALLOON_DONE_DURATION_MS);
    expect(BALLOON_DONE_DURATION_MS).toBeGreaterThanOrEqual(10_000);
  });
});
