import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  defer: true,
  banner: false,
  writes: [] as string[],
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: (_sessionId: string, data: string) => {
    hold.writes.push(data);
  },
}));

vi.mock('./cli-prompt-autoresponder', () => ({
  cliPromptAutoResponder: {
    shouldDeferInjection: () => hold.defer,
    isHoldingForBanner: () => hold.banner,
    forceAcceptResponse: () => null,
  },
}));

import { waitOutBootPrompts } from './boot-prompt-hold';

describe('waitOutBootPrompts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hold.defer = true;
    hold.banner = false;
    hold.writes = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps waiting past maxMs while only the migration banner holds — never pastes into the migration', async () => {
    hold.banner = true;
    let done = false;
    void waitOutBootPrompts('sess', 1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    // Migração terminou: o banner deixa de segurar e a injeção é liberada.
    hold.banner = false;
    hold.defer = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    expect(hold.writes).toEqual([]);
  });

  it('gives up at maxMs when no banner holds (menu path unchanged)', async () => {
    let done = false;
    void waitOutBootPrompts('sess', 1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000 + 700);
    expect(done).toBe(true);
  });
});
