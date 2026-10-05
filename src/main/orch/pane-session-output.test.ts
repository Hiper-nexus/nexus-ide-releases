import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  getSessionState: vi.fn((): "busy" | "idle" | null => "busy"),
}));

vi.mock("../pty/pty-manager", () => ({
  getSessionState: stubs.getSessionState,
}));

import {
  __evictExitedBufferForTests,
  __resetDeliberatelyClosedPanesForTests,
  markPaneDeliberatelyClosed,
  newOutputSince,
  paneSessionStateForEntry,
  recordPaneSessionExit,
  recordPaneSessionState,
  waitForIdle,
  waitForNextIdle,
  wasPaneDeliberatelyClosed,
  wasPaneSessionExitObserved,
} from "./pane-session-output";

describe("pane session idle wait cancellation", () => {
  it("rejects immediately with the exact abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("orchestration coordinator stopped");
    const pending = waitForIdle(
      "session-aborted-during-boot",
      60_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});


// Campo (14/08): o ring de sessão morta sai após 5min e o state do pane caía
// de volta pro último entry.state ('idle') — pane morto ressuscitava como
// vivo no snapshot e o watcher da Via Rápida nunca via livePanes===0.
describe("marca de exit persiste além do TTL do buffer", () => {
  it("pane morto continua 'exited' depois da evicção do ring", () => {
    // duas consultas: antes e depois da evicção do ring
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    recordPaneSessionState("pane-morto", "idle");
    recordPaneSessionExit("pane-morto");
    const entry = {
      paneId: "pane-morto",
      title: "pane morto",
      kind: "cli-agent",
      sessionId: "pane-morto",
      state: "idle" as const,
    } satisfies Parameters<typeof paneSessionStateForEntry>[0];
    expect(paneSessionStateForEntry(entry)).toBe("exited");
    __evictExitedBufferForTests("pane-morto");
    expect(paneSessionStateForEntry(entry)).toBe("exited");
  });
});

describe('waitForNextIdle — pane_ask não colhe a tela antiga', () => {
  it('pane já idle só resolve depois de busy→idle', async () => {
    stubs.getSessionState.mockReturnValue('idle');
    recordPaneSessionState('ask-idle', 'idle');
    let resolved: string | undefined;
    const pending = waitForNextIdle('ask-idle', 5_000).then((state) => {
      resolved = state;
      return state;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    recordPaneSessionState('ask-idle', 'busy');
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    recordPaneSessionState('ask-idle', 'idle');
    await expect(pending).resolves.toBe('idle');
  });

  it('pane já busy resolve no próximo idle (sem esperar outro busy)', async () => {
    stubs.getSessionState.mockReturnValue('busy');
    recordPaneSessionState('ask-busy', 'busy');
    const pending = waitForNextIdle('ask-busy', 5_000);
    recordPaneSessionState('ask-busy', 'idle');
    await expect(pending).resolves.toBe('idle');
  });
});

// F-918: o breaker de mortalidade só conta a CLI que saiu sozinha —
// exit precisa ter sido observado NESTE processo e o pane não pode ter
// sido fechado por pedido.
describe('exit observado × fechamento deliberado (F-918)', () => {
  it('sessão sem exit observado não prova morte espontânea', () => {
    expect(wasPaneSessionExitObserved('sessao-nunca-vista')).toBe(false);
    expect(wasPaneSessionExitObserved('')).toBe(false);
  });

  it('recordPaneSessionExit marca o exit como observado, além do TTL do buffer', () => {
    recordPaneSessionExit('sessao-morta-918');
    expect(wasPaneSessionExitObserved('sessao-morta-918')).toBe(true);
    __evictExitedBufferForTests('sessao-morta-918');
    expect(wasPaneSessionExitObserved('sessao-morta-918')).toBe(true);
  });

  it('fechamento deliberado é por paneId e começa falso', () => {
    __resetDeliberatelyClosedPanesForTests();
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(false);
    markPaneDeliberatelyClosed('pane-918');
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(true);
    expect(wasPaneDeliberatelyClosed('pane-outro')).toBe(false);
    // Close fire-and-forget: só desculpa o exit logo depois do pedido; a CLI
    // que seguiu viva e morreu sozinha minutos depois conta para o breaker.
    const markedAt = Date.now();
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt + 5_000)).toBe(true);
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt + 10 * 60_000)).toBe(false);
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt - 60_000)).toBe(false);
    __resetDeliberatelyClosedPanesForTests();
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(false);
  });
});

describe('newOutputSince — resposta do nexus_pane_ask', () => {
  it('devolve só o texto depois da âncora (última linha do before)', () => {
    const before = 'boot banner\n> prompt anterior\nresposta velha\n';
    const after = 'boot banner\n> prompt anterior\nresposta velha\nQuanto é 1+1?\n2\n';
    expect(newOutputSince(before, after)).toBe('Quanto é 1+1?\n2\n');
  });

  it('janela que rolou além da âncora devolve o after inteiro', () => {
    expect(newOutputSince('linha antiga\n', 'só coisa nova\n2\n')).toBe('só coisa nova\n2\n');
  });

  it('before vazio devolve o after inteiro', () => {
    expect(newOutputSince('', 'primeira resposta\n')).toBe('primeira resposta\n');
  });

  it('âncora repetida usa a ÚLTIMA ocorrência', () => {
    const before = 'ok\nfim\n';
    const after = 'fim\nmeio\nfim\nnovo\n';
    expect(newOutputSince(before, after)).toBe('novo\n');
  });
});
