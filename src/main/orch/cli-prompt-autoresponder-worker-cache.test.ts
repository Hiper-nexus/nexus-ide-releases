import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pty/pty-analysis-runtime', () => ({
  analysisClient: {
    status: () => 'active',
    generation: () => 1,
    control: () => undefined,
  },
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ cliPromptAutoResponderEnabled: true }),
}));

import { cliPromptAutoResponder } from './cli-prompt-autoresponder';

afterEach(() => {
  vi.useRealTimers();
});

describe('F-958 — snapshot do Worker depois do aceite', () => {
  it('o defer da resposta/verificação não segura o brief por 180 s', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const sessionId = 'pty-kimi-trust';
    const t0 = Date.now();
    // Kimi 2.1.1 abriu "Trust this folder?" e o Worker respondeu com Enter.
    cliPromptAutoResponder.acceptWorker(
      sessionId,
      {
        verifying: true,
        defer: true,
        banner: false,
        force: null,
        signature: 'kimi-folder-trust',
        response: '\r',
        fallbackResponse: undefined,
      },
      t0,
    );
    expect(cliPromptAutoResponder.shouldDeferInjection(sessionId)).toBe(true);
    // O TUI repintou: o Worker manda o "verified" ainda dentro do settle.
    cliPromptAutoResponder.acceptWorker(
      sessionId,
      { verifying: false, defer: true, banner: false, force: null, verified: true },
      t0 + 50,
    );
    vi.setSystemTime(t0 + 1_000);
    // Antes do F-958 isto ficava true até t0 + 180 s (o gate do composer do
    // Kimi esgotava 2 × 30 s e o pane era fechado como "brief-rejected").
    expect(cliPromptAutoResponder.shouldDeferInjection(sessionId)).toBe(false);
    cliPromptAutoResponder.drop(sessionId);
  });

  it('diálogo ainda pendente (sem resposta) continua segurando a entrega', () => {
    vi.useFakeTimers({ now: 2_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const sessionId = 'pty-kimi-pending';
    const t0 = Date.now();
    cliPromptAutoResponder.acceptWorker(
      sessionId,
      { verifying: false, defer: true, banner: false, force: null },
      t0,
    );
    vi.setSystemTime(t0 + 1_000);
    expect(cliPromptAutoResponder.shouldDeferInjection(sessionId)).toBe(true);
    cliPromptAutoResponder.drop(sessionId);
  });
});
