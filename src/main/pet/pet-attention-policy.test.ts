import { describe, expect, it } from 'vitest';
import type { PetEvent } from '../../shared/pet-types';
import {
  ATTENTION_TOAST_COOLDOWN_MS,
  DIGEST_WINDOW_MS,
  ITEM_COOLDOWN_MS,
  NOISE_KIND_LIMIT,
  admitPetEvent,
  createAttentionPolicyState,
} from './pet-attention-policy';

const ev = (
  kind: PetEvent['kind'],
  title: string,
  at = 1_000,
): PetEvent => ({ kind, title, at });

describe('pet-attention-policy', () => {
  it('engole agent-idle', () => {
    const s0 = createAttentionPolicyState();
    const r = admitPetEvent(s0, ev('agent-idle', 'x'), 1_000);
    expect(r.immediate).toBeNull();
    expect(r.scheduleDigest).toBe(false);
  });

  it('cooldown por missão/agente evita spam do mesmo item', () => {
    let s = createAttentionPolicyState();
    const t0 = 10_000;
    let r = admitPetEvent(s, ev('mission-blocked', 'Deploy'), t0);
    expect(r.scheduleDigest).toBe(true);
    s = r.state;
    r = admitPetEvent(s, ev('mission-blocked', 'Deploy'), t0 + 1_000);
    expect(r.scheduleDigest).toBe(false);
    expect(r.immediate).toBeNull();
    // depois do cooldown, aceita de novo (entra no digest)
    r = admitPetEvent(
      s,
      ev('mission-blocked', 'Deploy'),
      t0 + ITEM_COOLDOWN_MS + 1,
    );
    expect(r.scheduleDigest).toBe(true);
  });

  it('agrega vários urgentes num digest', () => {
    let s = createAttentionPolicyState();
    const t0 = 50_000;
    let r = admitPetEvent(s, ev('mission-blocked', 'A'), t0);
    s = r.state;
    r = admitPetEvent(s, ev('agent-waiting', 'claude'), t0 + 100);
    s = r.state;
    r = admitPetEvent(s, ev('agent-waiting', 'codex'), t0 + 200);
    s = r.state;
    expect(s.digestBuffer).toHaveLength(3);

    r = admitPetEvent(s, ev('mission-done', 'noop'), t0 + DIGEST_WINDOW_MS, {
      flushDigest: true,
    });
    expect(r.flushed).toHaveLength(1);
    expect(r.flushed[0]!.event.title).toMatch(/2 agentes|missões|A/);
    expect(r.flushed[0]!.deliverPet).toBe(true);
  });

  it('mantém falhas técnicas esgotadas fora da linguagem de decisão humana', () => {
    let s = createAttentionPolicyState();
    const t0 = 75_000;
    let r = admitPetEvent(
      s,
      ev('mission-technical-failure', 'Build'),
      t0,
    );
    s = r.state;
    r = admitPetEvent(
      s,
      ev('mission-technical-failure', 'Testes'),
      t0 + 100,
    );
    s = r.state;

    r = admitPetEvent(s, ev('mission-done', 'noop'), t0 + DIGEST_WINDOW_MS, {
      flushDigest: true,
    });

    expect(r.flushed).toHaveLength(1);
    expect(r.flushed[0]!.event.kind).toBe('mission-technical-failure');
    expect(r.flushed[0]!.event.title).toContain('2 missões com falha técnica');
    expect(r.flushed[0]!.event.title).not.toContain('precisam de você');
  });

  it('limita toasts de atenção no tempo', () => {
    let s = createAttentionPolicyState();
    const t0 = 100_000;
    let r = admitPetEvent(s, ev('mission-blocked', 'A'), t0);
    s = r.state;
    r = admitPetEvent(s, ev('mission-done', 'x'), t0, { flushDigest: true });
    expect(r.flushed[0]!.mirrorMain).toBe(true);
    s = r.state;

    r = admitPetEvent(s, ev('mission-blocked', 'B'), t0 + 1_000);
    s = r.state;
    r = admitPetEvent(s, ev('mission-done', 'y'), t0 + 1_000, {
      flushDigest: true,
    });
    // segundo toast dentro do cooldown → pet sim, main não
    expect(r.flushed[0]!.deliverPet).toBe(true);
    expect(r.flushed[0]!.mirrorMain).toBe(false);
    s = r.state;

    r = admitPetEvent(
      s,
      ev('mission-blocked', 'C'),
      t0 + ATTENTION_TOAST_COOLDOWN_MS + 2_000,
    );
    s = r.state;
    r = admitPetEvent(s, ev('mission-done', 'z'), t0 + ATTENTION_TOAST_COOLDOWN_MS + 2_000, {
      flushDigest: true,
    });
    expect(r.flushed[0]!.mirrorMain).toBe(true);
  });

  it('corta agent-exited em massa', () => {
    let s = createAttentionPolicyState();
    const t0 = 200_000;
    let emitted = 0;
    for (let i = 0; i < NOISE_KIND_LIMIT + 5; i += 1) {
      const r = admitPetEvent(s, ev('agent-exited', `s${i}`), t0 + i);
      s = r.state;
      if (r.immediate?.deliverPet) emitted += 1;
    }
    expect(emitted).toBe(NOISE_KIND_LIMIT);
  });

  it('entrega mission-done ao pet e espelha a conclusao na janela principal', () => {
    const result = admitPetEvent(
      createAttentionPolicyState(),
      ev('mission-done', 'Pet Studio'),
      300_000,
    );

    expect(result.immediate).toMatchObject({
      deliverPet: true,
      mirrorMain: true,
      event: { kind: 'mission-done', title: 'Pet Studio' },
    });
  });
});
