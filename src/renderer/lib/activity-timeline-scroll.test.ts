import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_TIMELINE_FOLLOW_THRESHOLD,
  ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION,
  createActivityScopeKey,
  resolveMaintainScrollAtEnd,
  scheduleDisclosureSettle,
} from './activity-timeline-scroll';

describe('createActivityScopeKey', () => {
  it('separa missão e filtro, para que nenhum dos dois herde a lista do outro', () => {
    const keys = new Set([
      createActivityScopeKey('m-1', 'all'),
      createActivityScopeKey('m-1', 'tools'),
      createActivityScopeKey('m-2', 'all'),
    ]);
    expect(keys.size).toBe(3);
    expect(createActivityScopeKey('m-1', 'all')).toBe(createActivityScopeKey('m-1', 'all'));
  });
});

describe('ACTIVITY_TIMELINE_FOLLOW_THRESHOLD', () => {
  it('é fração da viewport (unidade do Legend) e cabe em menos de uma linha', () => {
    // maintainScrollAtEndThreshold do Legend multiplica pela altura da viewport;
    // 1 seria "uma tela inteira" e seguiria quem rolou para cima.
    expect(ACTIVITY_TIMELINE_FOLLOW_THRESHOLD).toBeGreaterThan(0);
    expect(ACTIVITY_TIMELINE_FOLLOW_THRESHOLD).toBeLessThan(1);
    const viewport = 480;
    const closedCard = 48;
    expect(ACTIVITY_TIMELINE_FOLLOW_THRESHOLD * viewport).toBeLessThan(closedCard);
  });
});

describe('resolveMaintainScrollAtEnd', () => {
  it('segue o fim com animação por padrão', () => {
    expect(resolveMaintainScrollAtEnd({ disclosureSettling: false, reducedMotion: false })).toEqual({
      animated: true,
    });
  });

  it('não anima com movimento reduzido', () => {
    expect(resolveMaintainScrollAtEnd({ disclosureSettling: false, reducedMotion: true })).toEqual({
      animated: false,
    });
  });

  it('desliga o follow enquanto um detalhe abre ou fecha', () => {
    expect(resolveMaintainScrollAtEnd({ disclosureSettling: true, reducedMotion: false })).toBe(false);
    expect(resolveMaintainScrollAtEnd({ disclosureSettling: true, reducedMotion: true })).toBe(false);
  });
});

describe('ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION', () => {
  it('ancora o conteúdo visível em mudança de altura e de dados', () => {
    expect(ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION).toEqual({ data: true, size: true });
  });
});

function manualFrames() {
  let next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    frames: {
      request: (callback: FrameRequestCallback) => {
        const handle = next++;
        pending.set(handle, callback);
        return handle;
      },
      cancel: (handle: number) => {
        pending.delete(handle);
      },
    },
    tick() {
      const batch = Array.from(pending.entries());
      pending.clear();
      for (const [, callback] of batch) callback(0);
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

describe('scheduleDisclosureSettle', () => {
  it('libera o follow só depois de dois frames', () => {
    const clock = manualFrames();
    const onSettled = vi.fn();
    scheduleDisclosureSettle(onSettled, clock.frames);

    clock.tick();
    expect(onSettled).not.toHaveBeenCalled();
    clock.tick();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount).toBe(0);
  });

  it('cancelar antes do primeiro frame não libera nada', () => {
    const clock = manualFrames();
    const onSettled = vi.fn();
    const cancel = scheduleDisclosureSettle(onSettled, clock.frames);
    cancel();
    clock.tick();
    clock.tick();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('cancelar entre os frames também não libera', () => {
    const clock = manualFrames();
    const onSettled = vi.fn();
    const cancel = scheduleDisclosureSettle(onSettled, clock.frames);
    clock.tick();
    cancel();
    clock.tick();
    expect(onSettled).not.toHaveBeenCalled();
    expect(clock.pendingCount).toBe(0);
  });
});
